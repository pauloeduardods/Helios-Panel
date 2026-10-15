// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * helios-acer-lighting: keyboard RGB on Acer Predator laptops, through the
 * gaming WMI interface. It binds to the WMI device that mainline acer-wmi
 * calls without binding, so the two coexist, and it only exposes two
 * validated attributes:
 *
 *   keyboard_effect  "<effect> <speed> <brightness> <direction> <rrggbb>"
 *   keyboard_zones   "<brightness> <rrggbb> <rrggbb> <rrggbb> <rrggbb>"
 *   lighting_state   read-only diagnostics: "kbst=0xNN lbst=0xNN kles=0xNN"
 *   logo             "<on> <brightness> <rrggbb>": the lid logo's colour and power
 *   logo_effect      the same as keyboard_effect, for the lid logo
 *   keyboard_state   write-only, 0 to 15: the EC keyboard state (KBST)
 *   logo_state       write-only, "0" or "1": the lid logo off or on (LBST)
 *
 * It only binds on the machines in the DMI allow-list below. Nothing is
 * sent to the firmware at load time; only reads and writes of the
 * attributes call it. See docs/LIGHTING.md for the protocol.
 */
#include <linux/acpi.h>
#include <linux/delay.h>
#include <linux/device.h>
#include <linux/dmi.h>
#include <linux/module.h>
#include <linux/mutex.h>
#include <linux/slab.h>
#include <linux/sysfs.h>
#include <linux/wmi.h>

#include "lighting.h"

#define ACER_GAMING_WMI_GUID "7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56"
/* Time the EC needs to apply one lighting write before the next. */
#define EC_SETTLE_MS 100

struct helios_lighting {
	struct wmi_device *wdev;
	struct mutex lock;	/* one attribute operation at a time */
	struct hal_fw fw;
};

static const struct dmi_system_id allowed_machines[] = {
	{
		.ident = "Acer Predator PHN16-72",
		.matches = {
			DMI_EXACT_MATCH(DMI_SYS_VENDOR, "Acer"),
			DMI_EXACT_MATCH(DMI_PRODUCT_NAME, "Predator PHN16-72"),
		},
	},
	{ }
};

static int wmi_call(void *ctx, enum hal_method method, const u8 *in, size_t in_len,
		    u8 *out, size_t out_len)
{
	struct helios_lighting *hl = ctx;
	struct acpi_buffer input = { in_len, (void *)in };
	struct acpi_buffer output = { ACPI_ALLOCATE_BUFFER, NULL };
	union acpi_object *obj;
	acpi_status status;
	int ret = -EIO;

	switch (method) {
	case HAL_SET_STATE:
	case HAL_GET_STATE:
	case HAL_SET_ZONE:
	case HAL_GET_ZONE:
	case HAL_SET_EFFECT:
	case HAL_GET_EFFECT:
	case HAL_SET_LOGO:
	case HAL_GET_LOGO:
		break;
	default:
		return -EINVAL;
	}

	status = wmidev_evaluate_method(hl->wdev, 0, method, &input, &output);
	if (ACPI_FAILURE(status))
		return -EIO;

	obj = output.pointer;
	if (obj && obj->type == ACPI_TYPE_BUFFER && obj->buffer.length == out_len) {
		memcpy(out, obj->buffer.pointer, out_len);
		ret = 0;
	} else {
		dev_warn_ratelimited(&hl->wdev->dev, "unexpected reply to method %d\n", method);
	}
	kfree(obj);
	return ret;
}

static void ec_pause(void *ctx)
{
	msleep(EC_SETTLE_MS);
}

static ssize_t store(struct device *dev, const char *buf, size_t count,
		     int (*op)(const struct hal_fw *, const char *, size_t))
{
	struct helios_lighting *hl = dev_get_drvdata(dev);
	int ret;

	mutex_lock(&hl->lock);
	ret = op(&hl->fw, buf, count);
	mutex_unlock(&hl->lock);
	return ret ? ret : (ssize_t)count;
}

static ssize_t show(struct device *dev, char *buf,
		    int (*op)(const struct hal_fw *, char *))
{
	struct helios_lighting *hl = dev_get_drvdata(dev);
	char line[HAL_LINE_MAX];
	int ret;

	mutex_lock(&hl->lock);
	ret = op(&hl->fw, line);
	mutex_unlock(&hl->lock);
	return ret < 0 ? ret : sysfs_emit(buf, "%s", line);
}

static ssize_t keyboard_effect_store(struct device *dev, struct device_attribute *attr,
				     const char *buf, size_t count)
{
	return store(dev, buf, count, hal_effect_store);
}

static ssize_t keyboard_effect_show(struct device *dev, struct device_attribute *attr,
				    char *buf)
{
	return show(dev, buf, hal_effect_show);
}

static ssize_t keyboard_zones_store(struct device *dev, struct device_attribute *attr,
				    const char *buf, size_t count)
{
	return store(dev, buf, count, hal_zones_store);
}

static ssize_t keyboard_zones_show(struct device *dev, struct device_attribute *attr,
				   char *buf)
{
	return show(dev, buf, hal_zones_show);
}

static ssize_t lighting_state_show(struct device *dev, struct device_attribute *attr,
				   char *buf)
{
	return show(dev, buf, hal_state_show);
}

static ssize_t logo_store(struct device *dev, struct device_attribute *attr,
			  const char *buf, size_t count)
{
	return store(dev, buf, count, hal_logo_store);
}

static ssize_t logo_show(struct device *dev, struct device_attribute *attr, char *buf)
{
	return show(dev, buf, hal_logo_show);
}

static ssize_t logo_effect_store(struct device *dev, struct device_attribute *attr,
				 const char *buf, size_t count)
{
	return store(dev, buf, count, hal_logo_effect_store);
}

static ssize_t logo_effect_show(struct device *dev, struct device_attribute *attr,
				char *buf)
{
	return show(dev, buf, hal_logo_effect_show);
}

static ssize_t keyboard_state_store(struct device *dev, struct device_attribute *attr,
				    const char *buf, size_t count)
{
	return store(dev, buf, count, hal_keyboard_state_store);
}

static ssize_t logo_state_store(struct device *dev, struct device_attribute *attr,
				const char *buf, size_t count)
{
	return store(dev, buf, count, hal_logo_state_store);
}

static DEVICE_ATTR_ADMIN_RW(keyboard_effect);
static DEVICE_ATTR_ADMIN_RW(keyboard_zones);
static DEVICE_ATTR_ADMIN_RW(logo);
static DEVICE_ATTR_ADMIN_RW(logo_effect);
static DEVICE_ATTR_ADMIN_RO(lighting_state);
static DEVICE_ATTR_WO(keyboard_state);
static DEVICE_ATTR_WO(logo_state);

static struct attribute *helios_lighting_attrs[] = {
	&dev_attr_keyboard_effect.attr,
	&dev_attr_keyboard_zones.attr,
	&dev_attr_logo.attr,
	&dev_attr_logo_effect.attr,
	&dev_attr_lighting_state.attr,
	&dev_attr_keyboard_state.attr,
	&dev_attr_logo_state.attr,
	NULL
};
ATTRIBUTE_GROUPS(helios_lighting);

static int helios_lighting_probe(struct wmi_device *wdev, const void *context)
{
	struct helios_lighting *hl;

	if (!dmi_check_system(allowed_machines))
		return -ENODEV;

	hl = devm_kzalloc(&wdev->dev, sizeof(*hl), GFP_KERNEL);
	if (!hl)
		return -ENOMEM;

	mutex_init(&hl->lock);
	hl->wdev = wdev;
	hl->fw.call = wmi_call;
	hl->fw.pause = ec_pause;
	hl->fw.ctx = hl;
	dev_set_drvdata(&wdev->dev, hl);
	return 0;
}

static const struct wmi_device_id helios_lighting_ids[] = {
	{ ACER_GAMING_WMI_GUID, NULL },
	{ }
};
MODULE_DEVICE_TABLE(wmi, helios_lighting_ids);

static struct wmi_driver helios_lighting_driver = {
	.driver = {
		.name = "helios-acer-lighting",
		.dev_groups = helios_lighting_groups,
	},
	.id_table = helios_lighting_ids,
	.probe = helios_lighting_probe,
};
module_wmi_driver(helios_lighting_driver);

MODULE_AUTHOR("Helios Panel contributors");
MODULE_DESCRIPTION("Keyboard RGB for Acer Predator laptops (Helios Panel)");
MODULE_LICENSE("GPL");
MODULE_VERSION("0.1.6");
