// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Keyboard and logo lighting protocol: parses the attribute lines, builds
 * the exact firmware buffers and formats the read-back. No kernel
 * dependencies; see lighting.h.
 */
#include "lighting.h"

/* Method 20 byte 9 selects the target. */
#define TARGET_KEYBOARD 1
#define TARGET_LOGO 2
/*
 * Method 20 byte 8, stored by the firmware as KLES. The ACPI code gives it
 * no meaning; 3 is what the community drivers for this model send.
 */
#define STORED_STATE 3
/* Method 4 selectors: the keyboard state (KBST) and the logo state (LBST). */
#define STATE_KEYBOARD 0x08
#define STATE_LOGO 0x10
/* Method 12 and 13 accept only this selector. */
#define LOGO_SELECTOR 1

/*
 * Indexed by the firmware's effect number. Effect 0 (static) is shown when
 * read back but not accepted: on this machine it leaves the keyboard dark
 * (docs/LIGHTING.md).
 */
static const char *const effects[] = {
	"static", "breathing", "neon", "wave", "shifting", "zoom",
};

#define EFFECT_STATIC 0

/* Indexed by the firmware's direction number; 0 is not a direction. */
static const char *const directions[] = {
	NULL, "left", "right",
};

struct rgb {
	u8 r, g, b;
};

/* ---------------------------------------------------------------- parsing */

struct tokens {
	const char *word[6];
	size_t len[6];
	size_t count;
};

/*
 * Splits one line into words separated by single spaces. The line may end
 * with one newline. Anything else (empty words, tabs, a second line, NUL,
 * too many words) fails.
 */
static int split(const char *buf, size_t len, struct tokens *t, size_t want)
{
	size_t i, start = 0;

	if (len > 0 && buf[len - 1] == '\n')
		len--;
	if (len == 0 || len >= HAL_LINE_MAX)
		return -EINVAL;

	t->count = 0;
	for (i = 0; i <= len; i++) {
		if (i < len && buf[i] != ' ') {
			if (buf[i] < 0x21 || buf[i] > 0x7e)
				return -EINVAL;
			continue;
		}
		if (i == start || t->count == want)
			return -EINVAL;
		t->word[t->count] = buf + start;
		t->len[t->count] = i - start;
		t->count++;
		start = i + 1;
	}
	return t->count == want ? 0 : -EINVAL;
}

static int word_is(const char *word, size_t len, const char *name)
{
	size_t i;

	for (i = 0; i < len; i++)
		if (name[i] != word[i])
			return 0;
	return name[len] == '\0';
}

static int parse_name(const char *word, size_t len, const char *const *names,
		      size_t n, u8 *out)
{
	size_t i;

	for (i = 0; i < n; i++) {
		if (names[i] && word_is(word, len, names[i])) {
			*out = (u8)i;
			return 0;
		}
	}
	return -EINVAL;
}

/* A decimal number in 0..max, without sign or leading zeros. */
static int parse_uint(const char *word, size_t len, unsigned int max, u8 *out)
{
	unsigned int value = 0;
	size_t i;

	if (len == 0 || len > 3 || (len > 1 && word[0] == '0'))
		return -EINVAL;
	for (i = 0; i < len; i++) {
		if (word[i] < '0' || word[i] > '9')
			return -EINVAL;
		value = value * 10 + (unsigned int)(word[i] - '0');
	}
	if (value > max)
		return -EINVAL;
	*out = (u8)value;
	return 0;
}

static int hex_digit(char c)
{
	if (c >= '0' && c <= '9')
		return c - '0';
	if (c >= 'a' && c <= 'f')
		return c - 'a' + 10;
	if (c >= 'A' && c <= 'F')
		return c - 'A' + 10;
	return -1;
}

/* Exactly six hex digits, "rrggbb". */
static int parse_rgb(const char *word, size_t len, struct rgb *out)
{
	u8 bytes[3];
	size_t i;

	if (len != 6)
		return -EINVAL;
	for (i = 0; i < 3; i++) {
		int hi = hex_digit(word[2 * i]);
		int lo = hex_digit(word[2 * i + 1]);

		if (hi < 0 || lo < 0)
			return -EINVAL;
		bytes[i] = (u8)(hi << 4 | lo);
	}
	out->r = bytes[0];
	out->g = bytes[1];
	out->b = bytes[2];
	return 0;
}

/* ------------------------------------------------------------- formatting */

struct line {
	char *buf;
	size_t len;
};

static void put_str(struct line *l, const char *s)
{
	while (*s && l->len < HAL_LINE_MAX - 1)
		l->buf[l->len++] = *s++;
}

static void put_uint(struct line *l, u8 value)
{
	char digits[4];
	int n = 0;

	do {
		digits[n++] = (char)('0' + value % 10);
		value /= 10;
	} while (value);
	while (n > 0 && l->len < HAL_LINE_MAX - 1)
		l->buf[l->len++] = digits[--n];
}

static void put_rgb(struct line *l, const u8 *rgb)
{
	static const char hex[] = "0123456789abcdef";
	size_t i;

	for (i = 0; i < 3 && l->len < HAL_LINE_MAX - 2; i++) {
		l->buf[l->len++] = hex[rgb[i] >> 4];
		l->buf[l->len++] = hex[rgb[i] & 0xf];
	}
}

static void put_hex(struct line *l, u8 value)
{
	static const char hex[] = "0123456789abcdef";

	put_str(l, "0x");
	if (l->len < HAL_LINE_MAX - 2) {
		l->buf[l->len++] = hex[value >> 4];
		l->buf[l->len++] = hex[value & 0xf];
	}
}

static void put_name(struct line *l, const char *const *names, size_t n, u8 value)
{
	put_str(l, value < n && names[value] ? names[value] : "unknown");
}

static int finish(struct line *l)
{
	l->buf[l->len++] = '\n';
	l->buf[l->len] = '\0';
	return (int)l->len;
}

/* ---------------------------------------------------------- firmware calls */

/* Calls a set method and checks its status byte. */
static int set(const struct hal_fw *fw, enum hal_method method, const u8 *in, size_t in_len)
{
	u8 out[4] = { 0 };
	int ret = fw->call(fw->ctx, method, in, in_len, out, sizeof(out));

	if (ret)
		return ret;
	return out[0] == 0 ? 0 : -EIO;
}

/* Calls a get method with @in and checks its status byte. */
static int get(const struct hal_fw *fw, enum hal_method method, const u8 *in, size_t in_len,
	       u8 *out, size_t out_len)
{
	int ret = fw->call(fw->ctx, method, in, in_len, out, out_len);

	if (ret)
		return ret;
	return out[0] == 0 ? 0 : -EIO;
}

static int get_effect(const struct hal_fw *fw, u8 *out)
{
	const u8 in[HAL_GET_EFFECT_IN] = { TARGET_KEYBOARD, 0, 0, 0 };

	return get(fw, HAL_GET_EFFECT, in, sizeof(in), out, HAL_GET_EFFECT_OUT);
}

/* Method 4 only reads; @selector picks which register. */
static int get_state(const struct hal_fw *fw, u8 selector, u8 *out)
{
	const u8 in[HAL_GET_STATE_IN] = { selector, 0, 0, 0, 0, 0, 0, 0 };

	return get(fw, HAL_GET_STATE, in, sizeof(in), out, HAL_GET_STATE_OUT);
}

/* -------------------------------------------------------- keyboard_effect */

int hal_effect_store(const struct hal_fw *fw, const char *buf, size_t len)
{
	u8 in[HAL_SET_EFFECT_IN] = { 0 };
	u8 effect, speed, brightness, direction;
	struct tokens t;
	struct rgb c;

	if (split(buf, len, &t, 5) ||
	    parse_name(t.word[0], t.len[0], effects, ARRAY_SIZE(effects), &effect) ||
	    effect == EFFECT_STATIC ||
	    parse_uint(t.word[1], t.len[1], HAL_MAX_SPEED, &speed) ||
	    parse_uint(t.word[2], t.len[2], HAL_MAX_BRIGHTNESS, &brightness) ||
	    parse_name(t.word[3], t.len[3], directions, ARRAY_SIZE(directions), &direction) ||
	    parse_rgb(t.word[4], t.len[4], &c))
		return -EINVAL;

	in[0] = effect;
	in[1] = speed;
	in[2] = brightness;
	in[3] = 0;
	in[4] = direction;
	in[5] = c.r;
	in[6] = c.g;
	in[7] = c.b;
	in[8] = STORED_STATE;
	in[9] = TARGET_KEYBOARD;
	return set(fw, HAL_SET_EFFECT, in, sizeof(in));
}

int hal_effect_show(const struct hal_fw *fw, char *buf)
{
	u8 out[HAL_GET_EFFECT_OUT] = { 0 };
	struct line l = { buf, 0 };
	int ret = get_effect(fw, out);

	if (ret)
		return ret;
	put_name(&l, effects, ARRAY_SIZE(effects), out[1]);
	put_str(&l, " ");
	put_uint(&l, out[2]);
	put_str(&l, " ");
	put_uint(&l, out[3]);
	put_str(&l, " ");
	put_name(&l, directions, ARRAY_SIZE(directions), out[5]);
	put_str(&l, " ");
	put_rgb(&l, out + 6);
	return finish(&l);
}

/* ------------------------------------------------------------------- logo */

int hal_logo_store(const struct hal_fw *fw, const char *buf, size_t len)
{
	u8 colour[HAL_SET_LOGO_IN] = { 0 };
	u8 power[HAL_SET_EFFECT_IN] = { 0 };
	struct tokens t;
	u8 on, brightness;
	struct rgb c;
	int ret;

	if (split(buf, len, &t, 3) ||
	    parse_uint(t.word[0], t.len[0], 1, &on) ||
	    parse_uint(t.word[1], t.len[1], HAL_MAX_BRIGHTNESS, &brightness) ||
	    parse_rgb(t.word[2], t.len[2], &c))
		return -EINVAL;

	colour[0] = LOGO_SELECTOR;
	colour[1] = c.r;
	colour[2] = c.g;
	colour[3] = c.b;
	colour[4] = brightness;
	colour[5] = on;
	ret = set(fw, HAL_SET_LOGO, colour, sizeof(colour));
	if (ret)
		return ret;

	fw->pause(fw->ctx);
	power[0] = on;
	power[9] = TARGET_LOGO;
	return set(fw, HAL_SET_EFFECT, power, sizeof(power));
}

int hal_logo_show(const struct hal_fw *fw, char *buf)
{
	const u8 in[HAL_GET_LOGO_IN] = { LOGO_SELECTOR, 0, 0, 0 };
	u8 out[HAL_GET_LOGO_OUT] = { 0 };
	struct line l = { buf, 0 };
	int ret = get(fw, HAL_GET_LOGO, in, sizeof(in), out, sizeof(out));

	if (ret)
		return ret;
	put_uint(&l, out[5]);
	put_str(&l, " ");
	put_uint(&l, out[4]);
	put_str(&l, " ");
	put_rgb(&l, out + 1);
	return finish(&l);
}

/* --------------------------------------------------------- lighting_state */

int hal_state_show(const struct hal_fw *fw, char *buf)
{
	u8 keyboard[HAL_GET_STATE_OUT] = { 0 };
	u8 logo[HAL_GET_STATE_OUT] = { 0 };
	u8 effect[HAL_GET_EFFECT_OUT] = { 0 };
	struct line l = { buf, 0 };
	int ret;

	ret = get_state(fw, STATE_KEYBOARD, keyboard);
	if (!ret)
		ret = get_state(fw, STATE_LOGO, logo);
	if (!ret)
		ret = get_effect(fw, effect);
	if (ret)
		return ret;
	put_str(&l, "kbst=");
	put_hex(&l, keyboard[5]);
	put_str(&l, " lbst=");
	put_hex(&l, logo[6]);
	put_str(&l, " kles=");
	put_hex(&l, effect[9]);
	return finish(&l);
}
