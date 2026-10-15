// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Keyboard lighting protocol: parses the attribute lines, builds the exact
 * firmware buffers and formats the read-back. No kernel dependencies; see
 * lighting.h.
 */
#include "lighting.h"

/* Method 20 byte 9 selects the target. Only the keyboard is ever sent. */
#define TARGET_KEYBOARD 1
/*
 * Method 20 byte 8, stored by the firmware as KLES. The ACPI code only
 * stores it, but the static effect stays dark unless it is 3, the value the
 * community driver tested on this model sends (docs/LIGHTING.md).
 */
#define STORED_STATE 3

/* Indexed by the firmware's effect number. */
static const char *const effects[] = {
	"static", "breathing", "neon", "wave", "shifting", "zoom",
};

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

static int set_effect(const struct hal_fw *fw, u8 effect, u8 speed, u8 brightness,
		      u8 direction, struct rgb c)
{
	u8 in[HAL_SET_EFFECT_IN] = { 0 };

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

static int get_effect(const struct hal_fw *fw, u8 *out)
{
	u8 in[HAL_GET_EFFECT_IN] = { TARGET_KEYBOARD, 0, 0, 0 };
	int ret = fw->call(fw->ctx, HAL_GET_EFFECT, in, sizeof(in), out, HAL_GET_EFFECT_OUT);

	if (ret)
		return ret;
	return out[0] == 0 ? 0 : -EIO;
}

/* ------------------------------------------------------------- attributes */

int hal_effect_store(const struct hal_fw *fw, const char *buf, size_t len)
{
	struct tokens t;
	u8 effect, speed, brightness, direction;
	struct rgb c;

	if (split(buf, len, &t, 5) ||
	    parse_name(t.word[0], t.len[0], effects, ARRAY_SIZE(effects), &effect) ||
	    parse_uint(t.word[1], t.len[1], HAL_MAX_SPEED, &speed) ||
	    parse_uint(t.word[2], t.len[2], HAL_MAX_BRIGHTNESS, &brightness) ||
	    parse_name(t.word[3], t.len[3], directions, ARRAY_SIZE(directions), &direction) ||
	    parse_rgb(t.word[4], t.len[4], &c))
		return -EINVAL;

	return set_effect(fw, effect, speed, brightness, direction, c);
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

int hal_zones_store(const struct hal_fw *fw, const char *buf, size_t len)
{
	struct tokens t;
	struct rgb c[HAL_ZONES];
	const struct rgb black = { 0, 0, 0 };
	u8 brightness;
	size_t i;
	int ret;

	if (split(buf, len, &t, 1 + HAL_ZONES) ||
	    parse_uint(t.word[0], t.len[0], HAL_MAX_BRIGHTNESS, &brightness))
		return -EINVAL;
	for (i = 0; i < HAL_ZONES; i++)
		if (parse_rgb(t.word[1 + i], t.len[1 + i], &c[i]))
			return -EINVAL;

	/*
	 * Static effect at this brightness, then each zone's colour. The
	 * static call carries no direction and no colour of its own.
	 */
	ret = set_effect(fw, 0, 0, brightness, 0, black);
	if (ret)
		return ret;

	for (i = 0; i < HAL_ZONES; i++) {
		u8 in[HAL_SET_ZONE_IN] = { 0 };

		in[0] = (u8)(1u << i);
		in[1] = c[i].r;
		in[2] = c[i].g;
		in[3] = c[i].b;
		ret = set(fw, HAL_SET_ZONE, in, sizeof(in));
		if (ret)
			return ret;
	}
	return 0;
}

int hal_zones_show(const struct hal_fw *fw, char *buf)
{
	u8 effect[HAL_GET_EFFECT_OUT] = { 0 };
	struct line l = { buf, 0 };
	size_t i;
	int ret = get_effect(fw, effect);

	if (ret)
		return ret;
	put_uint(&l, effect[3]);
	for (i = 0; i < HAL_ZONES; i++) {
		u8 in[HAL_GET_ZONE_IN] = { (u8)(1u << i), 0, 0, 0 };
		u8 out[HAL_GET_ZONE_OUT] = { 0 };

		ret = fw->call(fw->ctx, HAL_GET_ZONE, in, sizeof(in), out, sizeof(out));
		if (ret)
			return ret;
		if (out[0] != 0)
			return -EIO;
		put_str(&l, " ");
		put_rgb(&l, out + 1);
	}
	return finish(&l);
}
