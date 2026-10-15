/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 * Keyboard and lid logo lighting protocol of the Acer gaming WMI interface,
 * as the PHN16-72 firmware implements it (see docs/LIGHTING.md).
 *
 * This file and lighting.c have no kernel dependencies, so the same code is
 * built into the module and into the userspace tests. Every firmware call
 * goes through struct hal_fw, which the module points at WMI and the tests
 * point at a fake.
 */
#ifndef HELIOS_LIGHTING_H
#define HELIOS_LIGHTING_H

#ifdef __KERNEL__
#include <linux/errno.h>
#include <linux/kernel.h>
#include <linux/types.h>
#else
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
typedef uint8_t u8;
#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))
#endif

/*
 * The only firmware methods this code can call. Others (fans, misc
 * settings, the turbo-key LED, the static zone colours) are deliberately
 * not listed.
 */
enum hal_method {
	HAL_GET_STATE = 4,	/* read-only: keyboard and logo state registers */
	HAL_SET_LOGO = 12,	/* logo colour, brightness and power */
	HAL_GET_LOGO = 13,	/* read the above */
	HAL_SET_EFFECT = 20,	/* effect, speed, brightness, direction, colour */
	HAL_GET_EFFECT = 21,	/* read the above */
};

/* Exact input and output sizes, from the firmware's buffers. */
#define HAL_GET_STATE_IN 8
#define HAL_GET_STATE_OUT 16
#define HAL_SET_LOGO_IN 8
#define HAL_SET_LOGO_OUT 4
#define HAL_GET_LOGO_IN 4
#define HAL_GET_LOGO_OUT 8
#define HAL_SET_EFFECT_IN 16
#define HAL_SET_EFFECT_OUT 4
#define HAL_GET_EFFECT_IN 4
#define HAL_GET_EFFECT_OUT 16

#define HAL_MAX_SPEED 9
#define HAL_MAX_BRIGHTNESS 100
/* Longest line the attributes accept or produce, newline included. */
#define HAL_LINE_MAX 64

/*
 * Calls one firmware method. @out_len is the exact output size expected.
 * Returns 0, or a negative errno if the call failed or the firmware
 * returned something of the wrong size.
 */
struct hal_fw {
	int (*call)(void *ctx, enum hal_method method, const u8 *in, size_t in_len,
		    u8 *out, size_t out_len);
	/*
	 * Waits between two writes of one operation: the EC applies a write
	 * some time after it lands.
	 */
	void (*pause)(void *ctx);
	void *ctx;
};

/*
 * keyboard_effect: "<effect> <speed> <brightness> <direction> <rrggbb>".
 * Store returns 0 or a negative errno; -EINVAL means nothing was sent.
 * Show writes one line into @buf (at least HAL_LINE_MAX bytes) and returns
 * its length, or a negative errno.
 */
int hal_effect_store(const struct hal_fw *fw, const char *buf, size_t len);
int hal_effect_show(const struct hal_fw *fw, char *buf);

/*
 * logo: "<on> <brightness> <rrggbb>", on being 0 or 1. Writes the logo's
 * own colour registers (method 12), then its power through method 20 with
 * the logo target, as the PHN16-72 driver nekro-sense does.
 */
int hal_logo_store(const struct hal_fw *fw, const char *buf, size_t len);
int hal_logo_show(const struct hal_fw *fw, char *buf);

/*
 * lighting_state (read-only diagnostics, for the static effect still under
 * investigation): "kbst=0xNN lbst=0xNN kles=0xNN".
 */
int hal_state_show(const struct hal_fw *fw, char *buf);

#endif
