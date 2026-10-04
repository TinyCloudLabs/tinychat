#!/usr/bin/env bash
# Start the AVD headless WITH a working microphone, in the background. Idempotent.
#
# Why not -no-window: it execs the headless qemu build, which has no PulseAudio backend
# ("Could not init `pa' audio driver"), so the guest mic is silent. -qt-hide-window runs the full
# qemu (needs libxkbfile1) and QT_QPA_PLATFORM=offscreen lets it run without an X server.
# KVM: run as a member of the kvm group; right after `usermod -aG kvm` use `sg kvm -c ...`.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/env.sh"
mkdir -p "$EXO_STATE"
if ps -eo comm | grep -q '^qemu-system'; then echo "emulator already running"; exit 0; fi
"$here/pulse-setup.sh"
cmd="export PULSE_SOURCE=vmic.monitor PULSE_SINK=emu_out QEMU_AUDIO_DRV=pa QT_QPA_PLATFORM=offscreen PULSE_SERVER=$PULSE_SERVER; \
exec $ANDROID_HOME/emulator/emulator -avd $EXO_AVD -qt-hide-window -no-snapshot -no-boot-anim -gpu swiftshader_indirect \
-allow-host-audio -port $EXO_EMULATOR_PORT ${EXO_EMULATOR_ARGS:-}"
if id -nG | grep -qw kvm; then runner=(bash -c "$cmd"); else runner=(sg kvm -c "$cmd"); fi
setsid nohup "${runner[@]}" > "$EXO_STATE/emulator.log" 2>&1 < /dev/null &
$ADB wait-for-device
until [ "$($ADB shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done
# Plain DNS (Private DNS "opportunistic" also works now that the API hosts are off the `_.` CNAME).
echo "emulator booted ($EXO_SERIAL)"
