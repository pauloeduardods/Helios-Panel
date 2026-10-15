// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Userspace tests of the lighting protocol code (lighting.c), against a
 * fake firmware that records every call. Run via: make test
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../lighting.h"

/* ------------------------------------------------------------ fake firmware */

#define MAX_CALLS 16

struct call {
	enum hal_method method;
	size_t pauses_before;	/* pauses since the previous call */
	u8 in[16];
	size_t in_len;
};

struct fake {
	struct call calls[MAX_CALLS];
	size_t count;
	size_t pending_pauses;
	int fail_at;		/* 1-based call number that fails; 0: never */
	int fail_with;		/* errno to return, or 0 for a bad status byte */
	u8 effect[HAL_GET_EFFECT_OUT];
	u8 logo[HAL_GET_LOGO_OUT];
	u8 kbst, lbst, lbet;
};

static int fake_call(void *ctx, enum hal_method method, const u8 *in, size_t in_len,
		     u8 *out, size_t out_len)
{
	struct fake *f = ctx;
	struct call *c;

	if (f->count == MAX_CALLS) {
		fprintf(stderr, "too many firmware calls\n");
		abort();
	}
	c = &f->calls[f->count++];
	c->method = method;
	c->pauses_before = f->pending_pauses;
	f->pending_pauses = 0;
	c->in_len = in_len;
	memcpy(c->in, in, in_len < sizeof(c->in) ? in_len : sizeof(c->in));

	memset(out, 0, out_len);
	if (f->fail_at == (int)f->count) {
		if (f->fail_with)
			return -f->fail_with;
		out[0] = 1;
		return 0;
	}
	switch (method) {
	case HAL_GET_EFFECT:
		memcpy(out, f->effect, out_len);
		break;
	case HAL_GET_LOGO:
		memcpy(out, f->logo, out_len);
		break;
	case HAL_GET_LOGO_MODE:
		out[1] = f->lbet;
		break;
	case HAL_GET_STATE:
		if (in[0] == 0x08)
			out[5] = f->kbst;
		else if (in[0] == 0x10)
			out[6] = f->lbst;
		else
			out[0] = 1;
		break;
	default:
		break;
	}
	return 0;
}

static void fake_pause(void *ctx)
{
	((struct fake *)ctx)->pending_pauses++;
}

static struct fake fake;
static struct hal_fw fw = { fake_call, fake_pause, &fake };

static void reset(void)
{
	memset(&fake, 0, sizeof(fake));
}

/* ----------------------------------------------------------------- harness */

static int failures;
static const char *current;

static void fail(const char *fmt, ...)
{
	va_list ap;

	fprintf(stderr, "FAIL %s: ", current);
	va_start(ap, fmt);
	vfprintf(stderr, fmt, ap);
	va_end(ap);
	fputc('\n', stderr);
	failures++;
}

#define CHECK(cond, ...) do { if (!(cond)) fail(__VA_ARGS__); } while (0)

static int effect_store(const char *line)
{
	return hal_effect_store(&fw, line, strlen(line));
}

static int logo_store(const char *line)
{
	return hal_logo_store(&fw, line, strlen(line));
}

static void check_bytes(const struct call *c, const u8 *want, size_t len, const char *what)
{
	CHECK(c->in_len == len, "%s: %zu bytes sent, want %zu", what, c->in_len, len);
	for (size_t i = 0; i < len && i < c->in_len; i++)
		CHECK(c->in[i] == want[i], "%s: byte %zu is 0x%02x, want 0x%02x",
		      what, i, c->in[i], want[i]);
}

/*
 * What must hold for every call, whatever the input: only the five
 * lighting methods, exact sizes, never the static effect, and the logo
 * target only for the logo's power call.
 */
static void check_invariants(void)
{
	for (size_t i = 0; i < fake.count; i++) {
		const struct call *c = &fake.calls[i];

		switch (c->method) {
		case HAL_SET_EFFECT:
			CHECK(c->in_len == HAL_SET_EFFECT_IN, "method 20 size");
			if (c->in[9] == 1) {
				CHECK(c->in[0] >= 1 && c->in[0] <= 5, "keyboard effect %u", c->in[0]);
				CHECK(c->in[1] <= 9, "speed %u", c->in[1]);
				CHECK(c->in[2] <= 100, "brightness %u", c->in[2]);
				CHECK(c->in[3] == 0, "byte 3 is %u", c->in[3]);
				CHECK(c->in[4] == 1 || c->in[4] == 2, "direction %u", c->in[4]);
				CHECK(c->in[8] == 3, "byte 8 is %u", c->in[8]);
			} else if (c->in[9] == 2) {
				CHECK(c->in[0] <= 1, "logo power %u", c->in[0]);
				for (int b = 1; b < 9; b++)
					CHECK(c->in[b] == 0, "logo power byte %d is %u", b, c->in[b]);
			} else {
				fail("method 20 target %u", c->in[9]);
			}
			for (int b = 10; b < 16; b++)
				CHECK(c->in[b] == 0, "method 20 byte %d is %u", b, c->in[b]);
			break;
		case HAL_SET_LOGO:
			CHECK(c->in_len == HAL_SET_LOGO_IN, "method 12 size");
			CHECK(c->in[0] == 1, "method 12 selector %u", c->in[0]);
			CHECK(c->in[4] <= 100, "logo brightness %u", c->in[4]);
			CHECK(c->in[5] <= 1, "logo power %u", c->in[5]);
			CHECK(c->in[6] == 0 && c->in[7] == 0, "method 12 tail");
			break;
		case HAL_SET_LOGO_MODE:
			CHECK(c->in_len == HAL_SET_LOGO_MODE_IN, "method 10 size");
			CHECK(c->in[0] == 1 && c->in[1] == 0, "method 10 selector");
			CHECK(c->in[2] == 0 || c->in[2] == 3 || c->in[2] == 4, "logo mode %u",
			      c->in[2]);
			for (int b = 3; b < 8; b++)
				CHECK(c->in[b] == 0, "method 10 byte %d is %u", b, c->in[b]);
			break;
		case HAL_GET_LOGO_MODE:
			CHECK(c->in_len == HAL_GET_LOGO_MODE_IN && c->in[0] == 1 && c->in[1] == 0 &&
			      c->in[2] == 0 && c->in[3] == 0, "method 11 input");
			break;
		case HAL_GET_EFFECT:
			CHECK(c->in_len == HAL_GET_EFFECT_IN && c->in[0] == 1 && c->in[1] == 0 &&
			      c->in[2] == 0 && c->in[3] == 0, "method 21 input");
			break;
		case HAL_GET_LOGO:
			CHECK(c->in_len == HAL_GET_LOGO_IN && c->in[0] == 1 && c->in[1] == 0 &&
			      c->in[2] == 0 && c->in[3] == 0, "method 13 input");
			break;
		case HAL_GET_STATE:
			CHECK(c->in_len == HAL_GET_STATE_IN, "method 4 size");
			CHECK(c->in[0] == 0x08 || c->in[0] == 0x10, "method 4 selector 0x%02x",
			      c->in[0]);
			for (int b = 1; b < 8; b++)
				CHECK(c->in[b] == 0, "method 4 byte %d is %u", b, c->in[b]);
			break;
		default:
			fail("method %d called", c->method);
		}
	}
}

/* ------------------------------------------------------------ keyboard_effect */

static void test_effect_bytes(void)
{
	reset();
	CHECK(effect_store("wave 4 80 right ff8000\n") == 0, "valid line rejected");
	CHECK(fake.count == 1 && fake.calls[0].method == HAL_SET_EFFECT, "one method 20 call");
	const u8 want[16] = { 3, 4, 80, 0, 2, 0xff, 0x80, 0x00, 3, 1 };

	check_bytes(&fake.calls[0], want, 16, "wave");
	CHECK(fake.calls[0].pauses_before == 0 && fake.pending_pauses == 0, "no pauses");
}

static void test_effect_names(void)
{
	static const char *const names[] = { "breathing", "neon", "wave", "shifting", "zoom" };
	static const char *const dirs[] = { "left", "right" };
	char line[64];

	for (int e = 0; e < 5; e++) {
		for (int d = 0; d < 2; d++) {
			reset();
			snprintf(line, sizeof(line), "%s 0 100 %s 00FFaa", names[e], dirs[d]);
			CHECK(effect_store(line) == 0, "%s rejected", line);
			CHECK(fake.count == 1, "%s: %zu calls", line, fake.count);
			CHECK(fake.calls[0].in[0] == e + 1, "%s: effect byte %u", line, fake.calls[0].in[0]);
			CHECK(fake.calls[0].in[4] == d + 1, "%s: direction byte %u", line,
			      fake.calls[0].in[4]);
			CHECK(fake.calls[0].in[5] == 0x00 && fake.calls[0].in[6] == 0xff &&
			      fake.calls[0].in[7] == 0xaa, "%s: colour", line);
			check_invariants();
		}
	}
}

/* Every number from 0 to 999: accepted exactly when in range, sent as is. */
static void test_effect_ranges(void)
{
	char line[64];

	for (int n = 0; n < 1000; n++) {
		reset();
		snprintf(line, sizeof(line), "breathing %d 50 left 000000", n);
		int ret = effect_store(line);

		if (n <= 9)
			CHECK(ret == 0 && fake.count == 1 && fake.calls[0].in[1] == n, "speed %d", n);
		else
			CHECK(ret == -EINVAL && fake.count == 0, "speed %d accepted", n);

		reset();
		snprintf(line, sizeof(line), "breathing 5 %d left 000000", n);
		ret = effect_store(line);
		if (n <= 100)
			CHECK(ret == 0 && fake.count == 1 && fake.calls[0].in[2] == n,
			      "brightness %d", n);
		else
			CHECK(ret == -EINVAL && fake.count == 0, "brightness %d accepted", n);
		check_invariants();
	}
}

static void test_effect_rejects(void)
{
	static const char *const bad[] = {
		"", "\n", "\n\n", "wave", "wave 4 80 right",
		"wave 4 80 right ff0000 extra",
		"static 0 100 right ff0000",
		"Wave 4 80 right ff0000",
		"meteor 4 80 right ff0000",
		"twinkling 4 80 right ff0000",
		"unknown 4 80 right ff0000",
		"3 4 80 right ff0000",
		"wave 04 80 right ff0000",
		"wave +4 80 right ff0000",
		"wave -1 80 right ff0000",
		"wave 4 080 right ff0000",
		"wave 4 1000 right ff0000",
		"wave 4 255 right ff0000",
		"wave 4 80 up ff0000",
		"wave 4 80 unknown ff0000",
		"wave 4 80 0 ff0000",
		"wave 4 80 Right ff0000",
		"wave 4 80 right #ff0000",
		"wave 4 80 right ff000",
		"wave 4 80 right ff00000",
		"wave 4 80 right gg0000",
		"wave 4 80 right 0xff00",
		"wave  4 80 right ff0000",
		" wave 4 80 right ff0000",
		"wave 4 80 right ff0000 ",
		"wave\t4 80 right ff0000",
		"wave 4 80 right ff0000\n\n",
		"wave 4 80 right ff0000\r\n",
	};

	for (size_t i = 0; i < ARRAY_SIZE(bad); i++) {
		reset();
		current = bad[i];
		CHECK(effect_store(bad[i]) == -EINVAL, "accepted");
		CHECK(fake.count == 0, "reached the firmware");
	}
	current = "effect rejects";

	/* An embedded NUL, and a line past the length limit. */
	reset();
	CHECK(hal_effect_store(&fw, "wave 4 80 right ff0000\0", 23) == -EINVAL, "NUL accepted");
	char longline[HAL_LINE_MAX + 8];

	memset(longline, 'a', sizeof(longline));
	CHECK(hal_effect_store(&fw, longline, sizeof(longline)) == -EINVAL, "long line accepted");
	CHECK(fake.count == 0, "rejects reached the firmware");
}

static void test_effect_errors(void)
{
	reset();
	fake.fail_at = 1;
	CHECK(effect_store("neon 0 50 left ffffff") == -EIO, "status 1 is not -EIO");

	reset();
	fake.fail_at = 1;
	fake.fail_with = ETIMEDOUT;
	CHECK(effect_store("neon 0 50 left ffffff") == -ETIMEDOUT, "call error lost");
}

static void test_effect_show(void)
{
	char buf[HAL_LINE_MAX];
	const u8 state[16] = { 0, 3, 4, 80, 0xff, 2, 0xff, 0x80, 0x00, 0 };

	reset();
	memcpy(fake.effect, state, sizeof(state));
	int n = hal_effect_show(&fw, buf);

	CHECK(n == (int)strlen("wave 4 80 right ff8000\n") && !strcmp(buf, "wave 4 80 right ff8000\n"),
	      "show gave %d \"%s\"", n, buf);
	CHECK(fake.count == 1 && fake.calls[0].method == HAL_GET_EFFECT, "one method 21 call");
	check_invariants();

	/* Static reads back (it cannot be set), and so do unknown values. */
	reset();
	const u8 still[16] = { 0, 0, 0, 100, 0xff, 2, 0xff, 0, 0, 3 };

	memcpy(fake.effect, still, sizeof(still));
	hal_effect_show(&fw, buf);
	CHECK(!strcmp(buf, "static 0 100 right ff0000\n"), "show gave \"%s\"", buf);

	reset();
	const u8 odd[16] = { 0, 7, 9, 100, 0xff, 0, 1, 2, 3, 0 };

	memcpy(fake.effect, odd, sizeof(odd));
	hal_effect_show(&fw, buf);
	CHECK(!strcmp(buf, "unknown 9 100 unknown 010203\n"), "show gave \"%s\"", buf);

	reset();
	fake.fail_at = 1;
	CHECK(hal_effect_show(&fw, buf) == -EIO, "bad status not reported");
}

/* -------------------------------------------------------------------- logo */

static void test_logo_bytes(void)
{
	const u8 colour[8] = { 1, 0xff, 0x66, 0x00, 70, 1, 0, 0 };
	const u8 power[16] = { 1, 0, 0, 0, 0, 0, 0, 0, 0, 2 };
	const u8 still[8] = { 1, 0, 0, 0, 0, 0, 0, 0 };
	const u8 cycle[8] = { 1, 0, 4, 0, 0, 0, 0, 0 };

	reset();
	CHECK(logo_store("1 70 ff6600\n") == 0, "valid logo line rejected");
	CHECK(fake.count == 3, "%zu calls, want 3", fake.count);
	CHECK(fake.calls[0].method == HAL_SET_LOGO, "first call is method 12");
	check_bytes(&fake.calls[0], colour, 8, "logo colour");
	CHECK(fake.calls[1].method == HAL_SET_EFFECT, "second call is method 20");
	check_bytes(&fake.calls[1], power, 16, "logo power");
	CHECK(fake.calls[2].method == HAL_SET_LOGO_MODE, "third call is method 10");
	check_bytes(&fake.calls[2], still, 8, "no mode is static");
	CHECK(fake.calls[0].pauses_before == 0 && fake.calls[1].pauses_before == 1 &&
	      fake.calls[2].pauses_before == 1 && fake.pending_pauses == 0,
	      "one pause between each two calls");
	check_invariants();

	reset();
	CHECK(logo_store("1 70 ff6600 cycle\n") == 0, "cycle rejected");
	check_bytes(&fake.calls[0], colour, 8, "cycle colour");
	check_bytes(&fake.calls[2], cycle, 8, "cycle mode");
	check_invariants();

	static const char *const modes[] = { "static", "breathing", "cycle" };
	static const u8 values[] = { 0, 3, 4 };

	for (size_t i = 0; i < ARRAY_SIZE(modes); i++) {
		char line[32];

		reset();
		snprintf(line, sizeof(line), "1 100 00ff00 %s", modes[i]);
		CHECK(logo_store(line) == 0 && fake.count == 3 && fake.calls[2].in[2] == values[i],
		      "%s", line);
		check_invariants();
	}

	reset();
	CHECK(logo_store("0 0 000000") == 0, "logo off rejected");
	CHECK(fake.calls[0].in[5] == 0 && fake.calls[1].in[0] == 0, "logo off bytes");
}

static void test_logo_ranges(void)
{
	char line[64];

	for (int n = 0; n < 1000; n++) {
		reset();
		snprintf(line, sizeof(line), "1 %d 00ff00", n);
		int ret = logo_store(line);

		if (n <= 100)
			CHECK(ret == 0 && fake.calls[0].in[4] == n, "logo brightness %d", n);
		else
			CHECK(ret == -EINVAL && fake.count == 0, "logo brightness %d accepted", n);
		check_invariants();
	}
}

static void test_logo_rejects(void)
{
	static const char *const bad[] = {
		"", "1", "1 100", "2 100 ff0000", "01 100 ff0000", "1 101 ff0000", "1 100 ff000",
		"on 100 ff0000", "1 100 ff0000 x", "1  100 ff0000", "1 100 #ff0000",
		"1 100 ff0000 Cycle", "1 100 ff0000 3", "1 100 ff0000 unknown",
		"1 100 ff0000 cycle x", "1 100 ff0000 cycle ", "1 100 ff0000  cycle",
		"1 100 ff0000 wave",
	};

	for (size_t i = 0; i < ARRAY_SIZE(bad); i++) {
		current = bad[i];
		reset();
		CHECK(logo_store(bad[i]) == -EINVAL, "accepted");
		CHECK(fake.count == 0, "reached the firmware");
	}
	current = "logo rejects";

	reset();
	fake.fail_at = 1;
	CHECK(logo_store("1 70 ff6600") == -EIO && fake.count == 1,
	      "kept going after a failed colour write");

	reset();
	fake.fail_at = 2;
	CHECK(logo_store("1 70 ff6600 cycle") == -EIO && fake.count == 2,
	      "set the mode after a failed power write");

	reset();
	fake.fail_at = 3;
	fake.fail_with = ETIMEDOUT;
	CHECK(logo_store("1 70 ff6600 cycle") == -ETIMEDOUT, "mode write error lost");
}

static void test_logo_show(void)
{
	char buf[HAL_LINE_MAX];
	const u8 state[8] = { 0, 0x12, 0x34, 0x56, 80, 1, 0, 0 };

	reset();
	memcpy(fake.logo, state, sizeof(state));
	hal_logo_show(&fw, buf);
	CHECK(!strcmp(buf, "1 80 123456 static\n"), "show gave \"%s\"", buf);
	CHECK(fake.count == 2 && fake.calls[0].method == HAL_GET_LOGO &&
	      fake.calls[1].method == HAL_GET_LOGO_MODE, "read uses methods 13 and 11");
	check_invariants();

	static const struct {
		u8 lbet;
		const char *want;
	} reads[] = {
		{ 3, "1 80 123456 breathing\n" }, { 4, "1 80 123456 cycle\n" },
		{ 1, "1 80 123456 unknown\n" }, { 9, "1 80 123456 unknown\n" },
		{ 255, "1 80 123456 unknown\n" },
	};

	for (size_t i = 0; i < ARRAY_SIZE(reads); i++) {
		reset();
		memcpy(fake.logo, state, sizeof(state));
		fake.lbet = reads[i].lbet;
		hal_logo_show(&fw, buf);
		CHECK(!strcmp(buf, reads[i].want), "LBET %u gave \"%s\"", reads[i].lbet, buf);
	}

	reset();
	fake.fail_at = 2;
	CHECK(hal_logo_show(&fw, buf) == -EIO, "failed mode read not reported");

	reset();
	fake.fail_at = 1;
	CHECK(hal_logo_show(&fw, buf) == -EIO, "bad status not reported");
}

/* ------------------------------------------------------------- lighting_state */

static void test_state_show(void)
{
	char buf[HAL_LINE_MAX];

	reset();
	fake.kbst = 0x01;
	fake.lbst = 0xf4;
	fake.effect[9] = 3;
	int n = hal_state_show(&fw, buf);

	CHECK(n > 0 && !strcmp(buf, "kbst=0x01 lbst=0xf4 kles=0x03\n"), "show gave \"%s\"", buf);
	CHECK(fake.count == 3, "%zu calls, want 3", fake.count);
	CHECK(fake.calls[0].method == HAL_GET_STATE && fake.calls[0].in[0] == 0x08, "KBST read");
	CHECK(fake.calls[1].method == HAL_GET_STATE && fake.calls[1].in[0] == 0x10, "LBST read");
	CHECK(fake.calls[2].method == HAL_GET_EFFECT, "KLES read");
	check_invariants();

	reset();
	fake.fail_at = 2;
	CHECK(hal_state_show(&fw, buf) == -EIO, "bad status not reported");
	CHECK(fake.count == 2, "kept reading after a failure");
}

/* --------------------------------------------------------------- fuzzing */

/*
 * Random lines built from protocol-like words: whatever is accepted, every
 * call must still satisfy the invariants.
 */
static void test_fuzz(void)
{
	static const char *const words[] = {
		"static", "wave", "zoom", "left", "right", "0", "9", "10", "100", "101",
		"255", "ff0000", "FFFFFF", "fff", "1", "2", "8", "unknown", "", "\n",
		"breathing", "cycle", "3", "4",
	};
	unsigned int seed = 12345;
	char line[128];

	current = "fuzz";
	for (int round = 0; round < 200000; round++) {
		size_t len = 0;
		int n = 1 + (int)((seed = seed * 1103515245u + 12345u) >> 16) % 7;

		for (int w = 0; w < n; w++) {
			const char *word = words[((seed = seed * 1103515245u + 12345u) >> 16) %
						 ARRAY_SIZE(words)];
			len += (size_t)snprintf(line + len, sizeof(line) - len, w ? " %s" : "%s", word);
		}
		reset();
		if (round & 1)
			hal_effect_store(&fw, line, len);
		else
			hal_logo_store(&fw, line, len);
		check_invariants();
		if (failures)
			return;
	}
}

int main(void)
{
	static const struct {
		const char *name;
		void (*fn)(void);
	} tests[] = {
		{ "effect bytes", test_effect_bytes },
		{ "effect names", test_effect_names },
		{ "effect ranges", test_effect_ranges },
		{ "effect rejects", test_effect_rejects },
		{ "effect errors", test_effect_errors },
		{ "effect show", test_effect_show },
		{ "logo bytes", test_logo_bytes },
		{ "logo ranges", test_logo_ranges },
		{ "logo rejects", test_logo_rejects },
		{ "logo show", test_logo_show },
		{ "state show", test_state_show },
		{ "fuzz", test_fuzz },
	};
	size_t n = ARRAY_SIZE(tests);

	for (size_t i = 0; i < n; i++) {
		int before = failures;

		current = tests[i].name;
		tests[i].fn();
		printf("%s %s\n", failures == before ? "ok  " : "FAIL", tests[i].name);
	}
	printf("%zu tests, %d failures\n", n, failures);
	return failures ? 1 : 0;
}
