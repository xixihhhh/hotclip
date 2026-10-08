# Installing HotClip on macOS

Download the Apple Silicon DMG from the [official releases](https://github.com/xixihhhh/hotclip/releases/latest), open it, and drag **HotClip.app** into **Applications**. Eject the disk image before launching the installed app.

## First launch

HotClip does not currently have an Apple Developer ID signature or Apple notarization. Starting with v0.32.1, the app bundle and its nested binaries are ad-hoc signed, and the release workflow verifies the bundle signature. This repairs the invalid resource seal in v0.32.0; it does **not** make the app trusted by Gatekeeper.

If macOS blocks the first launch, open **System Settings → Privacy & Security**, find the HotClip message, and choose **Open Anyway**. See [Apple's instructions](https://support.apple.com/en-us/102445).

## “HotClip is damaged and can't be opened”

1. Replace v0.32.0 with the latest version from the official releases. The v0.32.0 DMG passes its disk-image checksum, but the bundled app fails `codesign --verify --deep --strict` because its resource seal is missing.
2. If the latest download still shows this message, check the installed bundle in Terminal:

   ```bash
   codesign --verify --deep --strict --verbose=2 "/Applications/HotClip.app"
   ```

   If verification fails, delete that app and download it again. Do not bypass a failed signature check.
3. If verification succeeds and you trust the official download, remove the download quarantine attribute **only from HotClip**, then launch it again:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/HotClip.app"
   ```

   This is a manual exception for an app without Apple notarization. It does not disable Gatekeeper globally. If the app is installed elsewhere, replace the path with its actual location.

If it still fails, [report the issue](https://github.com/xixihhhh/hotclip/issues/14) with your macOS version, HotClip version, and signature verification output. Do not include personal paths or account details.
