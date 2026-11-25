# Sharing Builds and Updates

Optional. How to share your own build of Online Search with a team, and send them new versions privately. If you only run it yourself, you don't need any of this: `npm start` or `npm run dist` is enough. Once set up, it takes one command and about five minutes, most of which is the build.

## 1. How updates reach your team

1. You run the release command on your Mac.
2. It builds the installer and uploads it to a private Google Drive folder, **Online Search releases**, in your My Drive.
3. You share that folder with each person, by their Google account or their whole company domain. Nobody else can see it or download from it.
4. Every person's copy of the app looks in that folder, using their own Google sign-in, 10 seconds after it opens and every 6 hours after that. It also looks straight after they sign in, and whenever they choose **Settings → Updates → Check for updates**.
5. When there's a newer version, the app downloads it quietly in the background and gets it ready.
6. A notice then appears in the bottom corner, headed **Update ready**, with a **What's new** list of the features you gave the release command and two buttons:
   - **Restart now** closes the app, swaps in the new version and opens it again, in a few seconds;
   - **Later** hides the notice, and the update installs by itself the next time they quit the app.

Teammates never drag anything into Applications or see "Open Anyway" again. Nothing goes out until you run the command.

If the app can't replace itself (for example, it was opened straight from the installer window instead of from Applications, or the person can't change the Applications folder), the notice says **Install…** instead. That opens the installer so they can drag the new version across, as on first install.

Someone without access to the folder simply never sees an update, even if they have a copy of the app.

## 2. One-time setup

1. **Project dependencies installed.** In the project folder, run `npm install`.
2. **Sign-in settings present.** `desktop/config.json` must exist (see "Set up your own Google sign-in" in the README). It isn't stored in Git, so keep a backup of it.
3. **First release signs you in.** The first time you run the release command, your browser opens Google's sign-in. Use the Google account that should own the releases folder. The command only gets access to files it creates itself, not the rest of your Drive. It remembers the sign-in in `~/.config/online-search/`.
4. **The folder is created for you** on that first run, and its ID is saved in `desktop/config.json` as `releasesFolderId`. Every build after that knows where to look. Keep that line: a build without it can't find updates.

## 3. Giving someone access

Do this once per person, when they join.

1. Open **Online Search releases** in Google Drive (the release command prints its link).
2. Click **Share**.
3. Add the person:
   - a person: their Google account email address;
   - a whole company: their domain, if your Google Workspace allows sharing with other domains. Otherwise, add each person, or ask them for a Google Group address that includes everyone.
4. Give **Viewer** access and untick **Notify people** if you'd rather tell them yourself.
5. Make sure **General access** stays **Restricted**. Never choose "Anyone with the link": that would let anyone download the app.

To stop someone getting updates, remove them from the folder's sharing. Their current copy keeps working, but they won't see new versions.

## 4. Publishing a version

1. **Commit your changes.** The command refuses to run with uncommitted changes, so the release always matches the code. You also need to be on the `main` branch.
2. **Choose a version number.** It must be higher than the current one (shown in Settings and in `package.json`). As a rule of thumb:
   - change the last number for fixes (0.4.1 to 0.4.2);
   - change the middle number for new features (0.4.2 to 0.5.0).
3. **Run the command** in Terminal, from the project folder:

   ```bash
   npm run release -- 0.5.0 "Photos open with a single click" "Faster search in large folders" "Clearer download progress"
   ```

   Each quoted item is one bullet in the update notice's **What's new** list. Write them as short, neutral descriptions of the feature ("Faster search in large folders"), not addressed to anyone. The notice shows up to six; any more are summed up as "and 2 more".

4. **Wait for "✓ Online Search 0.5.0 is out."** The command:
   - sets the version number in the app;
   - builds the installer into `dist/0.5.0/`, with the install guide beside it;
   - uploads the installer and notes to the releases folder;
   - commits "Release 0.5.0", tags it `v0.5.0` and pushes to the private code repo.

Teammates with the app open see the notice within 6 hours, or at once with Check for updates.

## 5. Checking it worked

1. Open the releases folder in Google Drive and confirm the new `.dmg` is there.
2. On your own Mac, open Online Search and choose **Settings → Updates → Check for updates**. It should offer the new version (you own the folder, so you always have access).

## 6. Testing an installer before teammates get it

Install `dist/0.5.0/Online Search-0.5.0-arm64.dmg` on your own Mac first by opening it from Finder. If you want to hold a release back after uploading, move its `.dmg` out of the releases folder in Drive; the app only looks inside that folder.

## 7. If something goes wrong

| What you see | What to do |
|---|---|
| "Commit or discard your changes first" | Commit your work (or undo it), then run the command again. |
| "Switch to the main branch first" | Run `git switch main`. |
| "must be newer than the current version" | Pick a higher number than the one in `package.json`. |
| "The releases folder … is gone or not yours" | The folder was deleted or the saved ID is wrong. Restore the folder from Drive's Bin, or remove `releasesFolderId` from `desktop/config.json` to make a new one. A new folder means older copies of the app won't find updates; send those teammates the new installer by hand. |
| Sign-in problems | Delete `~/.config/online-search/release-sign-in.json` and run the command again to sign in afresh. |
| A bad version went out | Publish a fixed version with a higher number. The app never offers an older version, so moving forward is the only real fix. Moving the bad `.dmg` out of the folder stops anyone downloading it in the meantime. |
| The upload failed after the build | Nothing was committed yet. Undo the version change with `git checkout -- package.json web/js/settings.js` and run the command again. |

## 8. Testing the notice while developing

To see the update notice in a development copy, make it pretend to be an old version:

```bash
ONLINE_SEARCH_PRETEND_VERSION=0.1.0 npm start
```

It then offers the newest installer in the releases folder.

## 9. Good to know

- **Builds without `releasesFolderId`** (for example a fresh clone) never check for updates; everything else works the same.
- **The first install is by hand.** Send each person the installer once (with `desktop/INSTALL.md`); after that, every update installs through the app.
- **If an install goes wrong**, the old version is kept and opens as normal. A log of each install is in `~/Library/Application Support/Online Search/update-install.log`.
- **Nothing is published publicly.** Installers stay in your private Drive folder; they contain your Google sign-in settings, so only share them with people you'd add to your Google Cloud project's test users.
