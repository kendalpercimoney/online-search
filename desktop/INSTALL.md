# Installing Online Search

Online Search, by Percimoney Technologies, lets you browse, preview and search video footage stored in your Google Drive. These steps take about two minutes. You need a Mac with Apple Silicon (M1 or newer) running macOS 13 Ventura or later (Apple menu → About This Mac shows both).

## 1. Install the app

1. Open the **Online Search** .dmg file you were sent.
2. Drag **Online Search** into the **Applications** folder, then close the window.

## 2. Let your Mac open it

Online Search is made by **Kendal Percimoney** (Percimoney Technologies). It isn't registered with Apple, because that needs a paid Apple developer membership, so macOS blocks it the first time with a message such as "can't verify" or "can't be opened". You can trust it: it only talks to Google Drive with your own sign-in, and all of its code is public at [github.com/kendalpercimoney/online-search](https://github.com/kendalpercimoney/online-search) for anyone to check.

To let your Mac open it, you only need to do this once:

1. Make sure **Online Search** is in your **Applications** folder (step 1) and the copying has finished.
2. Open **Terminal**. It's in **Applications → Utilities**, or press ⌘ Space, type `Terminal` and press Return.
3. Copy this line, paste it into Terminal and press Return:

   ```bash
   xattr -cr "/Applications/Online Search.app"
   ```

   Terminal shows nothing back; that means it worked. The line removes the "downloaded from the internet" mark macOS puts on new apps, which is what triggers the block. It doesn't change the app or anything else on your Mac.
4. Close Terminal and open **Online Search** from your Applications folder.

Updates install themselves after this, so you won't need to do it again.

### If you'd rather not use Terminal

1. Open **Online Search** from Applications. When macOS says it can't verify the app, click **Done**.
2. Open **System Settings → Privacy & Security**, scroll down to the message about Online Search, click **Open Anyway** and confirm with your password.
3. Click **Open** when macOS asks again.

On some Macs this isn't enough and macOS still says the app "can't be opened". If so, please use the Terminal steps above.

### If it still won't open

Check **Apple menu → About This Mac**: Online Search needs an **Apple M1 chip or newer** and **macOS 13 (Ventura) or later**. If macOS is older, update it in **System Settings → General → Software Update**, then try again.

## 3. Sign in with Google

1. Click **Sign in with Google**. Your web browser opens on Google's sign-in page.
2. Choose your Google account.
3. Google will show a screen saying it hasn't verified the app. This is expected while Online Search is in early testing: click **Continue**.
4. Allow Online Search to see your Google Drive files, and to create its own catalogue files.
5. Your browser says you're signed in. Switch back to Online Search.

You stay signed in on this Mac until you sign out from Settings (the gear icon). If Google ever asks you to sign in again, it's the same steps.

## Using it

- **Browse:** photos and videos sit side by side. Open My Drive, Shared with me or a shared drive from the home screen, or use the link button at the top to open a Drive folder link.
- **Preview:** move the mouse across a clip to scrub through it. The first time, an orange bar along the bottom shows the preview loading. Click to play from that point.
- **Playing:** clips play from Google Drive's own smaller copies, at a quality that suits your connection. The menu at the top of the player lets you pick 1080p, 720p, 360p or Original (full quality, slower to start).
- **Saved previews:** previews are kept on your Mac so they're instant next time. Settings shows how much space they use and has a Clear button; once a month the app offers to clear any you haven't used.
- **Search:** open a folder of footage, tick **Include subfolders** if you'd like, and click **Catalog folder**. When it says "Searchable now", start typing in the search box (or press ⌘F): for example "people", "drone", "stage", or part of a file name. Results update as you type.
- **Download:** click the download button on a clip, or in the player. Files save straight to your Downloads folder.
- **Appearance:** open Settings (the gear icon) to choose a background and how frosted the glass looks.
- **Updates:** new versions download by themselves. When one is ready, a notice appears in the corner: click **Restart now** to update straight away, or **Later** and it updates the next time you quit. Settings also has **Check for updates**.

## Good to know

- Online Search only sees what your Google account can already see in Drive.
- To save a catalogue in a folder, you need edit access to that folder. Catalogue files appear in Drive as `.footage-scrub.idx` and are safe to delete.
- The first search or catalogue downloads a 66 MB search model, once.
- Footage stays in Google Drive and is processed on your Mac. Nothing is sent anywhere else.

If anything doesn't work, please get in touch with the person who sent you the app.
