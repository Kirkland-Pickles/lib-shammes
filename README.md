# Lib Shammes (game shortcut manager for Windows)

Lib Shammes is a helper for portable game libraries. It adds games you already
have on your PC to Steam as non-Steam shortcuts, then finds matching artwork
from SteamGridDB. Instead of setting up every shortcut and image one at a time,
point Lib Shammes at one or more game folders, review what it finds, and add the
games you want in less time.

It is made for games that are already installed but are not properly set up in
your Steam library. It does not install, move, or change the game files.

## How it works

1. **Connect Steam.** Lib Shammes finds your Steam installation and lets you
   choose which Steam user should receive the shortcuts.
2. **Add your SteamGridDB API key.** This is free and is used for game matching
   and artwork. You can skip this if you do not want artwork, although artwork
   is kind of the whole point.
3. **Add your game folders.** You can add one folder or several folders from
   different drives.
4. **Scan.** Lib Shammes checks each game folder, picks the most likely
   launcher, and tries to identify the game and its Steam AppID automatically.
5. **Choose artwork.** Match selected games automatically, search
   SteamGridDB yourself, or choose individual images.
6. **Review.** You can change the name, choose a different executable, correct
   the match, or change the artwork before anything is added to Steam.
7. **Add selected games.** Lib Shammes adds the selected games to Steam as
   non-Steam shortcuts and applies their artwork.

Lib Shammes uses checkboxes to choose which games an action applies to. Newly
scanned games with a launcher are selected automatically.

## Game folders

The normal layout is one folder per game:

```text
D:\Games\
  First Game\
    game.exe
  Second Game\
    launcher.exe
```

The game folders do not need to be on the same drive. Set the depth separately
for each added folder. Use 0 if you selected a single game's folder, 1 if it
contains your game folders directly, or 2 if they are another level down.
New folders default to 1.

The scan keeps the executables it finds as launcher choices. It ranks them
using the folder name, executable name, location, and file size, then chooses
the most likely launcher for the game. You can change its choice from the game
details if Lib Shammes gets it wrong.

**Find missed games** checks executables that were not assigned during the
normal scan.

## Identifying and matching games

Lib Shammes removes common tags from folder and executable names before trying
to identify a game. If it knows the exact Steam AppID, it uses that for an exact
SteamGridDB lookup. Otherwise, it searches SteamGridDB with the cleaned title.

Matches below the confidence limit are left unmatched for review. You can
search SteamGridDB from the game details and choose the correct match yourself.

Identification and artwork matching are separate from adding the shortcut.
You can correct the name, launcher, match, and artwork before writing anything
to Steam.

## Artwork

Lib Shammes supports wide capsules, vertical grids, heroes, logos, and icons.
You can let it find artwork for selected games or open the artwork picker and
choose each image yourself.

By default, bulk artwork downloads skip files that are already present in
Steam's grid folder. Animated, NSFW, and humor artwork are disabled by default
and can be enabled separately in Settings.

## What it changes

Lib Shammes writes to the following local files and folders:

- Shortcuts: `Steam\userdata\<user>\config\shortcuts.vdf`
- Artwork: `Steam\userdata\<user>\config\grid\`
- Lib Shammes settings and change journal: `%APPDATA%\Lib Shammes\`

Before changing an existing `shortcuts.vdf`, Lib Shammes makes a unique backup.
If the backup fails, the shortcut file is not written.

Adding a game will not claim or rewrite a shortcut created somewhere else.
Explicit artwork actions can change the artwork or icon for an existing
shortcut you selected.

Lib Shammes records the changes it makes to Steam. **Purge** uses that journal
to remove shortcuts added by Lib Shammes, restore supported shortcut fields,
and delete its artwork files if they have not been changed since. Purge before
using **Delete app data** if you want those changes undone. Deleting app data
removes the settings, saved matches, and journal needed for a complete undo.

Steam must be fully restarted before shortcut and artwork changes appear.

## Existing Steam entries

Existing non-Steam shortcuts appear beside scanned games. They can be matched,
given artwork, or removed when you explicitly select them. Lib Shammes does not
adopt them as app-managed shortcuts.

Installed Steam games can also appear in the list, but Lib Shammes does not
edit them at this point in its development.

## Requirements

- Windows is the only supported platform.
- Lib Shammes needs a SteamGridDB API key for matching and artwork.

The API key is stored in `%APPDATA%\Lib Shammes\config.json` and is
used for requests to SteamGridDB.

## Building from source

Building Lib Shammes requires Node.js LTS. Install the locked dependencies and
create the Windows installer with:

```bat
npm ci
npm run build
```

The installer is written to `dist\`. Lib Shammes has no runtime npm
dependencies. Electron and electron-builder are used to run and package the
app.

## Help

Use GitHub Issues to report a bug or suggest a change. Include what you were
doing when the problem happened. Do not include your SteamGridDB API key.

## License

Lib Shammes is licensed under GPL-3.0-only. See [LICENSE](LICENSE).
