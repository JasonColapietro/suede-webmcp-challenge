# Release runbook — Suede Agent Studio Android

Produces a signed AAB and **proves which key signed it**. A green build says
nothing about the signing key; only the fingerprint check does.

Prerequisite: both blockers in [BLOCKERS.md](./BLOCKERS.md) resolved.

## Environment

```bash
export JAVA_HOME=/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/usr/local/share/android-commandlinetools
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

JDK **21** specifically. JDK 26 fails Gradle 8.x with "Unsupported class file
major version 70". `ios-app/android/.java-version` pins this for CI.

## 1. Sync web assets and native config

```bash
cd ios-app
npm install
npx cap sync android
```

## 2. Signing credentials

```bash
cd ios-app/android
cp keystore.properties.example keystore.properties
$EDITOR keystore.properties     # git-ignored; never commit
```

## 3. Bump the version

`ios-app/android/app/build.gradle` — `versionCode` must increase on every
upload. Last committed value: `2` (`versionName "1.0.2"`). A `versionCode 3`
debug build exists on the local emulator, so **confirm the highest versionCode
already accepted in Play Console** before choosing the next one.

Add a matching `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`.

## 4. Build the bundle

```bash
cd ios-app/android
./gradlew clean bundleRelease
```

Output: `app/build/outputs/bundle/release/app-release.aab`

## 5. Verify which key actually signed it — do not skip

```bash
keytool -printcert -jarfile app/build/outputs/bundle/release/app-release.aab | grep -i SHA256
```

Compare the printed SHA-256 against the **upload certificate** shown in
Play Console → Test and release → Setup → App signing.

They must match. If `keytool` reports "Not a signed jar file", the build fell
through the unsigned path — `keystore.properties` was missing or unreadable,
and Gradle silently produced an unsigned bundle rather than failing.

Sanity-check the manifest too:

```bash
$ANDROID_HOME/build-tools/36.0.0/aapt2 dump badging \
  app/build/outputs/apk/release/app-release.apk | head -5
```

## 6. Runtime-verify the release build, not a debug build

```bash
emulator -avd suede_test -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &
# ~100s cold boot; no snapshot is saved, that is expected
adb devices

./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
adb shell am start -n ai.suede.agents/.MainActivity
adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png /tmp/s.png
adb logcat -d | grep -iE "ai.suede.agents|FATAL|AndroidRuntime"
```

The shell loads `https://agents.suedeai.ai`, so allow **~30-40s** after launch
before the first real content paints. A screenshot taken at 12s shows only the
splash and proves nothing.

### Driving the WebView for verification

Taps via `adb shell input tap` frequently do not register against this WebView.
Use the DevTools protocol instead — this is how the Play Billing surface was
confirmed:

```bash
PID=$(adb shell pidof ai.suede.agents | tr -d '\r')
adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
curl -s http://localhost:9222/json/list
```

Then connect to the `webSocketDebuggerUrl` with `websocket-client` and
**`suppress_origin=True`** — without it the handshake returns
`403 Rejected an incoming WebSocket connection from the http://localhost:9222
origin`. `Page.navigate` and `Runtime.evaluate` then work normally.

## 7. Upload

Play Console → Test and release → Production (or Internal testing) → Create new
release → upload the `.aab`.

Do not upload while the developer account is still Personal; the
organization conversion must complete first.
