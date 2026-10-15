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
	u8 in[16];
	size_t in_len;
};

struct fake {
	struct call calls[MAX_CALLS];
	size_t count;
	int fail_at;		/* 1-based call number that fails; 0: never */
	int fail_with;		/* errno to return, or 0 for a bad status byte */
	u8 effect[HAL_GET_EFFECT_OUT];
	u8 zones[HAL_ZONES][3];
	u8 kbst, lbst;
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
	case HAL_GET_STATE:
		if (in[0] == 0x08)
			out[5] = f->kbst;
		else if (in[0] == 0x10)
			out[6] = f->lbst;
		else
			out[0] = 1;
		break;
	case HAL_GET_ZONE:
		for (int z = 0; z < HAL_ZONES; z++)
			if (in[0] == 1u << z)
				memcpy(out + 1, f->zones[z], 3);
		break;
	default:
		break;
	}
	return 0;
}

static struct fake fake;
static struct hal_fw fw = { fake_call, &fake };

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

static int zones_store(const char *line)
{
	return hal_zones_store(&fw, line, strlen(line));
}

static void check_bytes(const struct call *c, const u8 *want, size_t len, const char *what)
{
	CHECK(c->in_len == len, "%s: %zu bytes sent, want %zu", what, c->in_len, len);
	for (size_t i = 0; i < len && i < c->in_len; i++)
		CHECK(c->in[i] == want[i], "%s: byte %zu is 0x%02x, want 0x%02x",
		      what, i, c->in[i], want[i]);
}

/*
 * What must hold for every call, whatever the input: only the four
 * lighting methods, exact sizes, the keyboard as the only target, and
 * single-zone masks with the logo bytes left at zero.
 */
static void check_invariants(void)
{
	for (size_t i = 0; i < fake.count; i++) {
		const struct call *c = &fake.calls[i];

		switch (c->method) {
		case HAL_SET_EFFECT:
			CHECK(c->in_len == HAL_SET_EFFECT_IN, "method 20 size");
			CHECK(c->in[9] == 1, "method 20 target is %u, not the keyboard", c->in[9]);
			CHECK(c->in[0] <= 5, "effect %u", c->in[0]);
			CHECK(c->in[1] <= 9, "speed %u", c->in[1]);
			CHECK(c->in[2] <= 100, "brightness %u", c->in[2]);
			CHECK(c->in[3] == 0, "byte 3 is %u", c->in[3]);
			CHECK(c->in[4] <= 2, "direction %u", c->in[4]);
			CHECK(c->in[8] == 3, "byte 8 is %u, not 3", c->in[8]);
			for (int b = 10; b < 16; b++)
				CHECK(c->in[b] == 0, "method 20 byte %d is %u", b, c->in[b]);
			break;
		case HAL_SET_ZONE:
			CHECK(c->in_len == HAL_SET_ZONE_IN, "method 6 size");
			CHECK(c->in[0] == 1 || c->in[0] == 2 || c->in[0] == 4 || c->in[0] == 8,
			      "zone mask 0x%02x", c->in[0]);
			for (int b = 4; b < 8; b++)
				CHECK(c->in[b] == 0, "method 6 byte %d is %u", b, c->in[b]);
			break;
		case HAL_GET_EFFECT:
			CHECK(c->in_len == HAL_GET_EFFECT_IN && c->in[0] == 1 && c->in[1] == 0 &&
			      c->in[2] == 0 && c->in[3] == 0, "method 21 input");
			break;
		case HAL_GET_ZONE:
			CHECK(c->in_len == HAL_GET_ZONE_IN && c->in[1] == 0 && c->in[2] == 0 &&
			      c->in[3] == 0, "method 7 input");
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
}

static void test_effect_names(void)
{
	static const char *const names[] = { "static", "breathing", "neon", "wave", "shifting", "zoom" };
	static const char *const dirs[] = { "left", "right" };
	char line[64];

	for (int e = 0; e < 6; e++) {
		for (int d = 0; d < 2; d++) {
			reset();
			snprintf(line, sizeof(line), "%s 0 100 %s 00FFaa", names[e], dirs[d]);
			CHECK(effect_store(line) == 0, "%s rejected", line);
			CHECK(fake.count == 1, "%s: %zu calls", line, fake.count);
			CHECK(fake.calls[0].in[0] == e, "%s: effect byte %u", line, fake.calls[0].in[0]);
			CHECK(fake.calls[0].in[4] == d + 1, "%s: direction byte %u", line, fake.calls[0].in[4]);
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

		if (n <= 9) {
			CHECK(ret == 0 && fake.count == 1 && fake.calls[0].in[1] == n, "speed %d", n);
		} else {
			CHECK(ret == -EINVAL && fake.count == 0, "speed %d accepted", n);
		}

		reset();
		snprintf(line, sizeof(line), "breathing 5 %d left 000000", n);
		ret = effect_store(line);
		if (n <= 100) {
			CHECK(ret == 0 && fake.count == 1 && fake.calls[0].in[2] == n, "brightness %d", n);
		} else {
			CHECK(ret == -EINVAL && fake.count == 0, "brightness %d accepted", n);
		}
		check_invariants();
	}
}

static void test_effect_rejects(void)
{
	static const char *const bad[] = {
		"", "\n", "\n\n", "wave", "wave 4 80 right",
		"wave 4 80 right ff0000 extra",
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

	/* An embedded NUL, and a line at the length limit. */
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
	CHECK(effect_store("static 0 50 left ffffff") == -EIO, "status 1 is not -EIO");

	reset();
	fake.fail_at = 1;
	fake.fail_with = ETIMEDOUT;
	CHECK(effect_store("static 0 50 left ffffff") == -ETIMEDOUT, "call error lost");
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

	/* Values Helios cannot set (e.g. from Windows) still read back. */
	reset();
	const u8 odd[16] = { 0, 7, 9, 100, 0xff, 0, 1, 2, 3, 0 };

	memcpy(fake.effect, odd, sizeof(odd));
	hal_effect_show(&fw, buf);
	CHECK(!strcmp(buf, "unknown 9 100 unknown 010203\n"), "show gave \"%s\"", buf);

	reset();
	fake.fail_at = 1;
	CHECK(hal_effect_show(&fw, buf) == -EIO, "bad status not reported");
}

/* ------------------------------------------------------------- keyboard_zones */

static void test_zones_bytes(void)
{
	reset();
	CHECK(zones_store("60 ff0000 00ff00 0000ff ffffff\n") == 0, "valid zones rejected");
	CHECK(fake.count == 5, "%zu calls, want 5", fake.count);

	/* As the community driver does on this model: no direction or colour. */
	const u8 effect[16] = { 0, 0, 60, 0, 0, 0, 0, 0, 3, 1 };

	CHECK(fake.calls[0].method == HAL_SET_EFFECT, "first call is method 20");
	check_bytes(&fake.calls[0], effect, 16, "static effect");

	const u8 zone[4][8] = {
		{ 1, 0xff, 0, 0 }, { 2, 0, 0xff, 0 }, { 4, 0, 0, 0xff }, { 8, 0xff, 0xff, 0xff },
	};
	for (int z = 0; z < 4; z++) {
		CHECK(fake.calls[1 + z].method == HAL_SET_ZONE, "call %d is method 6", 2 + z);
		check_bytes(&fake.calls[1 + z], zone[z], 8, "zone");
	}
	check_invariants();
}

static void test_zones_rejects(void)
{
	static const char *const bad[] = {
		"", "60", "60 ff0000 00ff00 0000ff",
		"60 ff0000 00ff00 0000ff ffffff 000000",
		"101 ff0000 00ff00 0000ff ffffff",
		"060 ff0000 00ff00 0000ff ffffff",
		"60 ff0000 00ff00 0000ff fffff",
		"60 ff0000 00ff00 0000ff #fffff",
		"60 ff0000 00ff00  0000ff ffffff",
		"wave ff0000 00ff00 0000ff ffffff",
	};

	for (size_t i = 0; i < ARRAY_SIZE(bad); i++) {
		reset();
		current = bad[i];
		CHECK(zones_store(bad[i]) == -EINVAL, "accepted");
		CHECK(fake.count == 0, "reached the firmware");
	}
	current = "zones rejects";
}

static void test_zones_stop_at_first_error(void)
{
	reset();
	fake.fail_at = 3;
	CHECK(zones_store("60 ff0000 00ff00 0000ff ffffff") == -EIO, "error not reported");
	CHECK(fake.count == 3, "%zu calls after a failure, want 3", fake.count);
}

static void test_zones_show(void)
{
	char buf[HAL_LINE_MAX];
	const u8 zones[4][3] = { { 0xff, 0, 0 }, { 0, 0xff, 0 }, { 0, 0, 0xff }, { 0x12, 0x34, 0x56 } };

	reset();
	fake.effect[3] = 75;
	memcpy(fake.zones, zones, sizeof(zones));
	int n = hal_zones_show(&fw, buf);

	CHECK(n > 0 && !strcmp(buf, "75 ff0000 00ff00 0000ff 123456\n"), "show gave \"%s\"", buf);
	CHECK(fake.count == 5 && fake.calls[0].method == HAL_GET_EFFECT, "calls");
	for (int z = 0; z < 4; z++)
		CHECK(fake.calls[1 + z].method == HAL_GET_ZONE && fake.calls[1 + z].in[0] == 1u << z,
		      "zone %d read", z);
	check_invariants();

	reset();
	fake.fail_at = 4;
	CHECK(hal_zones_show(&fw, buf) == -EIO, "bad zone status not reported");
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
			hal_zones_store(&fw, line, len);
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
		{ "zones bytes", test_zones_bytes },
		{ "zones rejects", test_zones_rejects },
		{ "zones stop at first error", test_zones_stop_at_first_error },
		{ "zones show", test_zones_show },
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
