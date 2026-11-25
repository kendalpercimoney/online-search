# Online Search: Product Overview

Online Search is an open-source project by Percimoney Technologies (MIT licence).

Online Search is a Mac app (also runnable in a browser) for finding the right shot in video footage and photos stored on Google Drive. Drive is a good place to keep footage but a poor place to look through it: every clip has to be opened one at a time, and previews load slowly. Online Search turns a Drive folder into a fast, visual library you can skim with the mouse and search by what is in the shot.

It is built as a web app inside a Mac app shell: someone installs it, signs in once with Google, keeps it in their Dock, and opens it whenever they need to find footage.

## 1. Who it is for

Video teams and content creators who store raw camera footage in Google Drive or shared drives and regularly need to find specific moments: a crowd shot, a speaker on stage, B-roll of a venue. It was built for and measured on a real library of 4K Sony XAVC event footage.

## 2. What it does today

| Feature | What the user sees | Why it matters |
|---|---|---|
| Sign in with Google | One click on the welcome screen; the Mac app opens the browser for Google's sign-in and stays signed in between launches | Uses each person's existing Drive permissions, so nobody manages a second set of accounts. |
| Folder browsing | Home screen with My Drive, Shared with me, Recent and every shared drive; folder tiles; breadcrumbs next to the item count; Back and Forward work | Footage libraries are deep folder trees. Every folder has its own link so it can be bookmarked. |
| Hover scrub | Moving the mouse across a clip scrubs through it, with a playhead and timecode; an orange bar along the bottom shows its preview frames arriving | Skimming a clip takes a second instead of opening and loading it. |
| Click to play | Opens a player at the moment you were hovering on, streaming Drive's own smaller copy (Auto, 1080p, 720p, 360p or Original) | Goes straight from "that looks right" to watching it, in a couple of seconds. |
| Photos | Photos sit in the grid beside videos, marked with a small photo badge. Clicking one opens it large; ← and → step through the photos on screen. Camera RAW and HEIC show too, through Drive's own preview | Shoots mix stills and clips; both are found and reviewed in one place. |
| Search as you type | Results update with every keystroke: file names (any part), then what is in the shot, for videos and photos alike | Finding a clip takes a word, not a folder-by-folder hunt. |
| Download | A download button on every clip and in the player; the Mac app saves straight to Downloads with a progress notice and a Dock progress bar | No browser tabs or Google pages in between. |
| Updates | New versions download in the background; a notice with what's new offers Restart now, or the update installs on next quit. Settings has Check for updates | Optional: a team stays current without being sent files. Installers sit in a private Drive folder shared only with that team, and nothing restarts without the person's say-so. |
| Appearance | Liquid Glass panels over a calm gradient background; seven backgrounds plus Auto (follows light or dark mode), and a glass slider from clear to frosted | A calm, focused place to review footage, adjustable to taste and lighting. |

## 3. How hover scrub stays fast

Google Drive takes several seconds to answer each request for part of a file. A normal video player needs many requests in a row before it can show a frame, so hover previews built that way never load on 4K camera files.

Online Search instead reads only the clip's index (the part of an MP4 or MOV that says where each frame is stored), then fetches up to 60 evenly spaced keyframes in parallel and decodes them in the app. The result is a "filmstrip" of small frames that scrubs instantly, saved on the computer so a clip that has been previewed before scrubs straight away.

In the Mac app, filmstrips come from Drive's 360p copy of the clip instead of the camera original (see 3.1). Keyframes in those copies are about 5 seconds apart, so each frame is decoded from the run of frames leading up to it: the strip shows exactly the moments wanted, still one per second up to 60. Frames are 320 pixels wide. For a 16-second 4K clip this took 1.2 MB and 2 seconds, against 21 MB for keyframes of the original. Clips Drive hasn't processed yet, and the browser version, use the original's keyframes.

Filmstrips are built when a clip is hovered; Settings has a switch, "Prepare previews in the background", to build them for every clip on screen. While a clip is playing or downloading, filmstrip and catalogue downloads pause so they don't compete with it. Filmstrips are saved on the computer. Settings shows how much space they use and can clear them, and once a month the app offers to clear any not previewed in the past month.

### 3.1 Playback

Camera originals are very high bit rate: 4K camera files typically run at 90 to 270 Mbit/s, several times a typical home or office connection. When a video is uploaded, Google Drive makes smaller copies (360p, 720p and 1080p, typically 0.5 to 5 Mbit/s), which its own player streams. Google's public API doesn't list these, but the endpoint Drive's player uses answers to the app's existing sign-in, so the Mac app plays them too.

- **Quality:** a menu in the player offers Auto, 1080p, 720p, 360p and Original. Auto picks from the connection speed the app has measured (1080p from about 8 Mbit/s, 720p from about 4). The choice is remembered.
- **Speed:** on a 10 Mbit/s connection, a 448 MB 4K clip started mid-clip in 1.9 seconds from its 720p copy (3.3 MB in total), against 25 to 60 seconds from the original.
- **How:** the copies' addresses expire after a few hours and can't be read by web pages directly, so the Mac app reaches them through a local route protected by a random key per launch (`desktop/copies.js`).
- **Fallback:** clips Drive hasn't processed, a copy that fails, and the browser version play the original. Before the first frame, the player needs the start of the file, its index (at the end for camera files), the first frame and the frame it seeks to; Online Search fetches these in parallel up front and hands them to the player through a service worker.
- **Risk:** the copies endpoint is undocumented, so Google could change it. Everything falls back to the original if it does.

## 4. Visual search

Typing a word like "worship", "people" or "drone" brings up the clips that contain it, best match first. Searching from inside a folder covers that folder and its subfolders; searching from Home covers everything catalogued. Results appear in about half a second.

### 4.1 Approach

Search uses MobileCLIP (the small "S0" version), an AI model that turns both images and text into lists of numbers (embeddings) that can be compared. This lets any search phrase work, not just a fixed list of objects. Classic object detectors only know about 80 everyday objects and have no idea what "worship" looks like.

### 4.2 How cataloguing stays fast

The slow part of cataloguing is not the AI; it is getting frames out of Google Drive. A single frame of 4K camera footage is 1 to 2 MB, and Drive takes several seconds to answer each request. Cataloguing every frame of a large library would mean tens of gigabytes and hours of waiting.

Instead, clips are catalogued in levels, cheapest first:

| Level | Frames used | Cost per clip | When |
|---|---|---|---|
| 1. Thumbnail | Drive's own thumbnail, which is always the clip's first frame | About 30 KB, a fraction of a second | "Catalog folder", first phase |
| 2. Keyframes | The thumbnail plus one frame per 15 seconds, for clips of 15 seconds or more | A few MB, around 15 seconds | "Catalog folder", second phase |
| 3. Full | Every hover filmstrip frame (up to 60) | Already downloaded for hover scrub | Automatically, when a clip's filmstrip is built |

A photo is a single frame, so it is fully catalogued in the first phase from Drive's 640-pixel preview. A folder of 37 stills took 20 seconds.

Measured on a real event-footage library (1,442 clips, 199 GB, 4.4 hours of footage, mostly short takes with a median of 6 seconds):

- Phase 1 made the whole library searchable in **under 2 minutes** (about 13 clips per second).
- Phase 2 only needed to visit the 111 clips of 15 seconds or more.
- The first attempt, which built a full filmstrip for every clip, was on course to take about 6 hours.

### 4.3 Why the stored data is small

- **Only distinct shots are stored.** A static shot is stored once; a clip that cuts between angles stores one entry per angle.
- **Each entry is compressed** to 512 bytes (one byte per number instead of four), with no measurable change in search ranking.
- Measured on the same library: 1,414 clips in 21 index files totalling 1.3 MB, or about 940 bytes per clip (most clips are a single shot).

### 4.4 The model

MobileCLIP S0 is downloaded once (66 MB) and cached by the browser, then runs on the Mac's graphics chip at about 40 ms per frame. Frames never leave the user's computer, and there are no per-use costs.

The larger MobileCLIP S2 was tested side by side on 595 clips from that library. It was better for "worship" but worse for "speaker on stage" and "drone shot", while doubling the download and slowing cataloguing, so S0 was kept. Each index file records which model created it, so switching models later simply re-catalogues (about 2 minutes for a library this size).

### 4.5 Where the catalogue is stored

Each catalogued folder gets a small index file, `.footage-scrub.idx`, stored in that folder on Google Drive. (The file name dates from the project's working title, Footage Scrub, and is kept so existing catalogues keep working.)

- The catalogue travels with the footage: if a folder is moved or shared, anyone who can see the footage can also search it.
- Everyone shares one index file per folder. Before saving, the tool merges in anything others added since it last read the file, so nobody's work is lost. If someone can't write to the shared file, the tool saves a second file and merges the two when searching.
- Saving index files needs one extra Google permission, "files created by this app" (`drive.file`). The tool still cannot change or delete footage.
- Index files are cached in the browser and only downloaded again when they change, which is why searches are fast.

### 4.6 When cataloguing happens

- **On request:** a "Catalog folder" button, with an "Include subfolders" option, a progress readout and a Stop button. Stopping is safe: everything catalogued so far is saved and searchable, and pressing the button again carries on where it left off.
- **Automatically while browsing:** any clip whose hover filmstrip gets built is upgraded to the full level.

### 4.7 Google's limits

Google's thumbnail server refuses requests ("429 Too Many Requests") when thumbnails are read too quickly, for a minute or more. The tool paces thumbnail requests to about 12 a second, backs off when Google pushes back, and leaves any clip it could not read for the next run rather than falling back to slow frame downloads. Thumbnails shown on screen are not affected.

## 5. Design review: is this the best approach?

Reviewed in November 2026 against the alternatives, with measurements from that library.

| Decision | Alternatives considered | Why the current choice wins |
|---|---|---|
| Embeddings (MobileCLIP S0) for visual search | Object detectors (YOLO and similar); captioning models; cloud vision APIs; larger CLIP models | Detectors only know about 80 everyday objects and can't find "worship". Captioning in the browser takes about a second per frame. Cloud APIs cost money per frame and send footage off the Mac. The larger MobileCLIP S2 was tested side by side and was not consistently better while doubling the download. |
| Thumbnail first, detail later | Building a full filmstrip for every clip before it is searchable | The full approach was measured at about 6 hours for 1,442 clips, limited by Drive's per-request delay. Thumbnail first made the same library searchable in under 2 minutes. |
| Index files stored with the footage on Drive | A central database or server; one index file for the whole library | No server to run or pay for; catalogues follow folders when they are moved or shared; each folder's file stays small. A single library file would become a bottleneck when several people catalogue at once. |
| Brute-force scoring in memory | A vector database or approximate-nearest-neighbour index | Scoring every catalogued shot takes about 2 ms for 1,400 clips and would take roughly 30 ms for 50,000. An index structure adds complexity with no visible benefit at this scale. |
| Search as you type in stages | Search on Enter; one combined query | File-name matches appear instantly from memory, visual matches follow about 0.1 s later, and Drive's own name search fills in clips that aren't catalogued. No step waits for a slower one. |
| Filmstrip frames kept within a memory budget | Keeping every decoded frame in memory | Each decoded frame is about 0.5 MB; browsing a few folders previously grew memory by hundreds of MB. Frames beyond the budget are released and reload from browser storage in a fraction of a second. |
| Playback prefetch through the service worker | Pointing the player straight at Drive; transcoding to a streaming format | The player alone needs three or four slow trips to Drive in a row before the first frame. Fetching the file's ends and the starting stretch in parallel up front removes most of that wait without any server. |

Changes worth considering later:

- **Speech search** (roadmap item 2) would add the biggest new capability: finding clips by what is said, stored alongside the visual data in the same index files.
- **New uploads** are only catalogued when someone presses Catalog folder or hovers them. A periodic check of Drive's change feed could catalogue new footage automatically.
- **Very large libraries** (tens of thousands of clips across hundreds of folders) would benefit from a small per-shared-drive summary file, so search loads one file per drive instead of one per folder.

## 6. Architecture

A web app with no build step, written as small JavaScript modules in `web/`, inside a Mac app shell (Electron, in `desktop/`). The same `web/` code also runs in a browser for development. The README has a file-by-file code map.

| Layer | Role |
|---|---|
| Mac app shell | Serves the web app from inside the app, signs in through the system browser (keeping the session encrypted in the Keychain), saves downloads straight to the Downloads folder, and checks for new versions |
| Screens | Navigation, folder tiles, clip cards with hover-scrub, search as you type, settings, player |
| Filmstrips | Reads MP4/MOV indexes, fetches keyframes, decodes them with WebCodecs, keeps them within a memory budget and saves them on the computer |
| Search catalogue | Catalogues clips with MobileCLIP in a background worker, saves and merges index files on Drive, scores searches in memory |
| Streaming | A service worker that adds the Google sign-in to the player's requests and serves prefetched bytes |

Google services used: the Google Drive API v3 and Google sign-in. Platform features used: WebCodecs, WebGPU, Web Workers, IndexedDB and Service Workers.

## 7. Privacy and access

- The tool only sees what the signed-in person can already see in Drive.
- Footage goes directly from Google Drive to the user's browser. There is no server in between that stores or views it.
- Search processing happens on the user's own computer.
- The Google sign-in lasts one hour and is kept only for the current browser tab.

## 8. Known limits

- The browser must be able to decode the footage: H.264 and H.265 (MP4 or MOV) work; ProRes, DNxHD and camera RAW do not.
- Hover scrub shows roughly one frame per second of footage, up to 60 per clip.
- Drive's smaller copies go up to 1080p. "Original" plays the full-quality file, which starts slowly on an ordinary connection.
- The copies come from an undocumented Drive endpoint; if Google changes it, the app falls back to the originals.
- Visual search matches what is visible in the shot, not what is said. It can also be drawn to words that appear on screen: a sign reading "Cafe" can come up for "coffee".
- Clips catalogued at the thumbnail level are matched on their first frame only, so a moment later in a short clip can be missed until the clip is hovered.
- Index files are visible as ordinary files inside Drive folders.
- Photos are shown from Drive's preview, up to 2400 pixels on the long side; Download gets the full-resolution file. Image types Drive can't preview (for example Photoshop files) are left out.
- Photos are searched from a 640-pixel version, which is plenty for what is in the shot but won't pick out fine detail.

## 9. Roadmap

1. **Visual search refinements:** show which level each clip is catalogued at, and catalogue new uploads automatically.
2. **Speech search:** transcribe the audio of each clip so searches also match what people say, stored in the same index files.
3. **Hosting and sign-in for the team:** host the app at a web address and let everyone in the Workspace organisation sign in with their own Google account.
4. **Mac Dock app:** install the hosted tool as a Mac app (Safari "Add to Dock" or Chrome "Install app") so it opens in its own window from the Dock.
5. **Sharing without sign-in (on hold):** either public-link folders read with an API key, or private folders served through a small proxy with a secret link.
