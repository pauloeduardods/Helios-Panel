# SPDX-License-Identifier: GPL-2.0-or-later
#
#   make          build the module against the running kernel (KDIR=... for another)
#   make test     build and run the userspace tests of the protocol code
#   make clean
#
# Building never loads anything. DKMS uses the kbuild part below.

ifneq ($(KERNELRELEASE),)

obj-m := helios-acer-lighting.o
helios-acer-lighting-y := driver.o lighting.o
ccflags-y := -Werror

else

KDIR ?= /lib/modules/$(shell uname -r)/build
TEST_BIN := tests/test_lighting
TEST_CFLAGS := -std=c11 -g -O1 -Wall -Wextra -Wshadow -Wconversion -Werror \
	-fsanitize=address,undefined -fno-sanitize-recover=all

all:
	$(MAKE) -C $(KDIR) M=$(CURDIR) modules

test: $(TEST_BIN)
	./$(TEST_BIN)

$(TEST_BIN): tests/test_lighting.c lighting.c lighting.h
	$(CC) $(TEST_CFLAGS) -o $@ tests/test_lighting.c lighting.c

clean:
	$(MAKE) -C $(KDIR) M=$(CURDIR) clean
	rm -f $(TEST_BIN)

.PHONY: all test clean

endif
