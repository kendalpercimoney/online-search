# Installing Online Search

Online Search, by Percimoney Technologies, lets you browse, preview and search video footage stored in your Google Drive. These steps take about two minutes. You need a Mac with Apple Silicon (M1 or newer) running macOS 13 Ventura or later (Apple menu → About This Mac shows both).

## 1. Install the app

1. Open the **Online Search** .dmg file you were sent.
2. Drag **Online Search** into the **Applications** folder, then close the window.

## 2. Open it the first time

Online Search isn't registered with Apple yet, so macOS asks you to confirm the first time you open it. You only need to do this once.

1. Open **Online Search** from your Applications folder. macOS will say it can't verify the app. Click **Done**.
2. Open **System Settings**, then **Privacy & Security**.
3. Scroll down to the message about Online Search and click **Open Anyway**, then confirm with your password.
4. Click **Open** when macOS asks again.

### If it still won't open

If macOS says **"The application can't be opened"**, or that the app **"is damaged"**, or there's no **Open Anyway** button:

1. Check **Apple menu → About This Mac**. The macOS version must be **13 (Ventura) or later**, and the chip must be **Apple M1 or newer**. If macOS is older, update it in **System Settings → General → Software Update** first.
2. Make sure Online Search is in your **Applications** folder (not opened straight from the installer window), and that the installer has finished copying it.
3. Open **Terminal** (in Applications → Utilities), paste this line and press Return:

   ```bash
   xattr -cr "/Applications/Online Search.app"
   ```

   This removes the "downloaded from the internet" mark macOS puts on the app, which is what's blocking it. It changes nothing else.
4. Open Online Search from Applications again.

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
