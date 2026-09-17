'use strict';
/* Resolve folder and executable names to a title and optional Steam AppID.
   Uncertain AppIDs remain null for title search. */
const strips = require('./strips');
// [title, steamAppid|null]
const ALIASES = {
  rdr2: ['Red Dead Redemption 2', 1174180],
  rdr1: ['Red Dead Redemption', null],
  rdr: ['Red Dead Redemption', null],
  reddeadredemption2: ['Red Dead Redemption 2', 1174180],
  gta5: ['Grand Theft Auto V', 271590],
  gtav: ['Grand Theft Auto V', 271590],
  gtaiv: ['Grand Theft Auto IV', 12210],
  gta4: ['Grand Theft Auto IV', 12210],
  gtasa: ['Grand Theft Auto: San Andreas', 12120],
  sanandreas: ['Grand Theft Auto: San Andreas', 12120],
  gtavc: ['Grand Theft Auto: Vice City', 12110],
  vicecity: ['Grand Theft Auto: Vice City', 12110],
  gta3: ['Grand Theft Auto III', 12100],
  maxpayne3: ['Max Payne 3', 204100],
  lan: ['L.A. Noire', null],
  lanoire: ['L.A. Noire', null],
  witcher3: ['The Witcher 3: Wild Hunt', 292030],
  tw3: ['The Witcher 3: Wild Hunt', 292030],
  witcher3wildhunt: ['The Witcher 3: Wild Hunt', 292030],
  witcher2: ['The Witcher 2: Assassins of Kings', 20920],
  cyberpunk2077: ['Cyberpunk 2077', 1091500],
  cp2077: ['Cyberpunk 2077', 1091500],
  cyberpunk: ['Cyberpunk 2077', 1091500],
  eldenring: ['ELDEN RING', 1245620],
  darksouls3: ['DARK SOULS III', 374320],
  ds3: ['DARK SOULS III', 374320],
  darksouls2: ['Dark Souls II', null],
  ds2: ['Dark Souls II', null],
  darksouls: ['Dark Souls: Remastered', null],
  ds1: ['Dark Souls: Remastered', null],
  sekiro: ['Sekiro: Shadows Die Twice', 814380],
  bloodborne: ['Bloodborne', null],
  armoredcore6: ['ARMORED CORE VI FIRES OF RUBICON', 1888160],
  ac6: ['ARMORED CORE VI FIRES OF RUBICON', 1888160],
  eldenringnightreign: ['ELDEN RING NIGHTREIGN', null],
  godofwar: ['God of War', 1593500],
  gow: ['God of War', 1593500],
  horizonzerodawn: ['Horizon Zero Dawn Complete Edition', 1151640],
  hzd: ['Horizon Zero Dawn Complete Edition', 1151640],
  ghostoftsushima: ["Ghost of Tsushima DIRECTOR'S CUT", 2215430],
  got: ["Ghost of Tsushima DIRECTOR'S CUT", 2215430],
  spidermanremastered: ["Marvel's Spider-Man Remastered", 1817070],
  spiderman: ["Marvel's Spider-Man Remastered", 1817070],
  milesmorales: ["Marvel's Spider-Man: Miles Morales", 1817190],
  tlou: ['The Last of Us Part I', 1888930],
  thelastofus: ['The Last of Us Part I', 1888930],
  uncharted: ['UNCHARTED: Legacy of Thieves Collection', 1659420],
  daysgone: ['Days Gone', 1259420],
  deathstranding: ['DEATH STRANDING DIRECTOR\u2019S CUT', 1190460],
  helldivers2: ['HELLDIVERS 2', 553850],
  returnal: ['Returnal', null],
  ratchetandclankriftapart: ['Ratchet & Clank: Rift Apart', null],
  horizonforbiddenwest: ['Horizon Forbidden West Complete Edition', null],
  godofwarragnarok: ['God of War Ragnarok', null],
  skyrim: ['The Elder Scrolls V: Skyrim Special Edition', 489830],
  skyrimse: ['The Elder Scrolls V: Skyrim Special Edition', 489830],
  oblivion: ['The Elder Scrolls IV: Oblivion', null],
  morrowind: ['The Elder Scrolls III: Morrowind', 22320],
  fallout4: ['Fallout 4', 377160],
  fo4: ['Fallout 4', 377160],
  falloutnv: ['Fallout: New Vegas', 22380],
  fnv: ['Fallout: New Vegas', 22380],
  fallout3: ['Fallout 3', 22370],
  fo3: ['Fallout 3', 22370],
  fallout76: ['Fallout 76', 1151340],
  fo76: ['Fallout 76', 1151340],
  starfield: ['Starfield', 1716740],
  doom: ['DOOM', 379720],
  doom2016: ['DOOM', 379720],
  doometernal: ['DOOM Eternal', 782330],
  hi: ['Hi-Fi RUSH', 1817230],
  hifirush: ['Hi-Fi RUSH', 1817230],
  ghostwiretokyo: ['Ghostwire: Tokyo', null],
  deathloop: ['DEATHLOOP', 1252330],
  dishonored2: ['Dishonored 2', 403640],
  dishonored: ['Dishonored', null],
  prey: ['Prey', 480490],
  redfall: ['Redfall', null],
  hl2: ['Half-Life 2', 220],
  halflife2: ['Half-Life 2', 220],
  hl1: ['Half-Life', 70],
  halflife: ['Half-Life', 70],
  hlalyx: ['Half-Life: Alyx', 546560],
  alyx: ['Half-Life: Alyx', 546560],
  portal: ['Portal', 400],
  portal2: ['Portal 2', 620],
  tf2: ['Team Fortress 2', 440],
  cs2: ['Counter-Strike 2', 730],
  csgo: ['Counter-Strike 2', 730],
  css: ['Counter-Strike: Source', 240],
  l4d2: ['Left 4 Dead 2', 550],
  gmod: ["Garry's Mod", 4000],
  haloinfinite: ['Halo Infinite', 1240440],
  halomcc: ['Halo: The Master Chief Collection', 976730],
  minecraft: ['Minecraft', null],
  terraria: ['Terraria', 105600],
  stardewvalley: ['Stardew Valley', 413150],
  stardew: ['Stardew Valley', 413150],
  factorio: ['Factorio', 427520],
  rimworld: ['RimWorld', 294100],
  satisfactory: ['Satisfactory', 526870],
  subnautica: ['Subnautica', 264710],
  subnauticabelowzero: ['Subnautica: Below Zero', 848450],
  belowzero: ['Subnautica: Below Zero', 848450],
  raft: ['Raft', 648800],
  valheim: ['Valheim', 892970],
  vrising: ['V Rising', 1604030],
  palworld: ['Palworld', 1623730],
  enshrouded: ['Enshrouded', 1203620],
  grounded: ['Grounded', 962130],
  theforest: ['The Forest', 242760],
  sonsoftheforest: ['Sons Of The Forest', 1326470],
  greenhell: ['Green Hell', 815370],
  projectzomboid: ['Project Zomboid', 108600],
  '7daystodie': ['7 Days to Die', 251570],
  '7dtd': ['7 Days to Die', 251570],
  dayz: ['DayZ', 221100],
  rust: ['Rust', 252490],
  ark: ['ARK: Survival Evolved', 346110],
  nms: ["No Man's Sky", 275850],
  nomanssky: ["No Man's Sky", 275850],
  astroneer: ['ASTRONEER', 361420],
  spaceengineers: ['Space Engineers', 244850],
  kerbalspaceprogram: ['Kerbal Space Program', 220200],
  ksp: ['Kerbal Space Program', 220200],
  starbound: ['Starbound', 211820],
  corekeeper: ['Core Keeper', 1621690],
  baldursgate3: ["Baldur's Gate 3", 1086940],
  bg3: ["Baldur's Gate 3", 1086940],
  divinityoriginalsin2: ['Divinity: Original Sin 2', 435150],
  dos2: ['Divinity: Original Sin 2', 435150],
  discoelysium: ['Disco Elysium', 632470],
  outerwilds: ['Outer Wilds', 753640],
  theouterworlds: ['The Outer Worlds', null],
  kingdomcomedeliverance: ['Kingdom Come: Deliverance', 379430],
  kcd: ['Kingdom Come: Deliverance', 379430],
  kingdomcomedeliverance2: ['Kingdom Come: Deliverance II', 1771300],
  kcd2: ['Kingdom Come: Deliverance II', 1771300],
  mountandblade2: ['Mount & Blade II: Bannerlord', 261550],
  bannerlord: ['Mount & Blade II: Bannerlord', 261550],
  xcom2: ['XCOM 2', 268500],
  persona5royal: ['Persona 5 Royal', 1687950],
  p5r: ['Persona 5 Royal', 1687950],
  persona4golden: ['Persona 4 Golden', 1113000],
  p4g: ['Persona 4 Golden', 1113000],
  persona3reload: ['Persona 3 Reload', 2161700],
  nierautomata: ['NieR:Automata', 524220],
  automata: ['NieR:Automata', 524220],
  monsterhunterworld: ['Monster Hunter: World', 582010],
  mhw: ['Monster Hunter: World', 582010],
  monsterhunterrise: ['Monster Hunter Rise', 1446780],
  mhr: ['Monster Hunter Rise', 1446780],
  monsterhunterwilds: ['Monster Hunter Wilds', 2246340],
  mhwilds: ['Monster Hunter Wilds', 2246340],
  yakuza0: ['Yakuza 0', 638970],
  yakuza7: ['Yakuza: Like a Dragon', 1235140],
  likeadragoninfinitewealth: ['Like a Dragon: Infinite Wealth', 2072450],
  finalfantasy14: ['FINAL FANTASY XIV Online', 39210],
  ffxiv: ['FINAL FANTASY XIV Online', 39210],
  masseffectlegendaryedition: ['Mass Effect Legendary Edition', null],
  civilization6: ["Sid Meier's Civilization VI", 289070],
  civ6: ["Sid Meier's Civilization VI", 289070],
  civilization7: ["Sid Meier's Civilization VII", 1295660],
  civ7: ["Sid Meier's Civilization VII", 1295660],
  stellaris: ['Stellaris', 281990],
  crusaderkings3: ['Crusader Kings III', 1158310],
  ck3: ['Crusader Kings III', 1158310],
  heartsofiron4: ['Hearts of Iron IV', 394360],
  hoi4: ['Hearts of Iron IV', 394360],
  europauniversalis4: ['Europa Universalis IV', 236850],
  eu4: ['Europa Universalis IV', 236850],
  totalwarwarhammer3: ['Total War: WARHAMMER III', 1142710],
  twwh3: ['Total War: WARHAMMER III', 1142710],
  ageofempires4: ['Age of Empires IV: Anniversary Edition', 1466860],
  aoe4: ['Age of Empires IV: Anniversary Edition', 1466860],
  manorlords: ['Manor Lords', 1363080],
  northgard: ['Northgard', 466560],
  anno1800: ['Anno 1800', 916440],
  frostpunk: ['Frostpunk', 323190],
  frostpunk2: ['Frostpunk 2', 1601580],
  oxygennotincluded: ['Oxygen Not Included', 457140],
  dwarffortress: ['Dwarf Fortress', 975370],
  planetzoo: ['Planet Zoo', 703080],
  dysonsphereprogram: ['Dyson Sphere Program', 1366540],
  warhammer40000spacemarine2: ['Warhammer 40,000: Space Marine 2', 2183900],
  spacemarine2: ['Warhammer 40,000: Space Marine 2', 2183900],
  battletech: ['BATTLETECH', 637090],
  intothebreach: ['Into the Breach', 590380],
  titanfall2: ['Titanfall 2', 1237970],
  apexlegends: ['Apex Legends', 1172470],
  apex: ['Apex Legends', 1172470],
  destiny2: ['Destiny 2', 1085660],
  warframe: ['Warframe', 230410],
  pubg: ['PUBG: BATTLEGROUNDS', 578080],
  deadbydaylight: ['Dead by Daylight', 381210],
  dbd: ['Dead by Daylight', 381210],
  phasmophobia: ['Phasmophobia', 739630],
  phasmo: ['Phasmophobia', 739630],
  lethalcompany: ['Lethal Company', 1966720],
  readyornot: ['Ready or Not', 1144200],
  squad: ['Squad', 393380],
  hellletloose: ['Hell Let Loose', 686810],
  arma3: ['Arma 3', 107410],
  insurgencysandstorm: ['Insurgency: Sandstorm', 581320],
  huntshowdown: ['Hunt: Showdown 1896', 594650],
  thefinals: ['THE FINALS', 2073850],
  battlebitremastered: ['BattleBit Remastered', 671610],
  payday3: ['PAYDAY 3', 1272080],
  payday2: ['PAYDAY 2', 218620],
  gtfo: ['GTFO', 493520],
  deeprockgalactic: ['Deep Rock Galactic', 548430],
  drg: ['Deep Rock Galactic', 548430],
  warhammervermintide2: ['Warhammer: Vermintide 2', 552500],
  vermintide2: ['Warhammer: Vermintide 2', 552500],
  warhammer40kdarktide: ['Warhammer 40,000: Darktide', 1361210],
  darktide: ['Warhammer 40,000: Darktide', 1361210],
  back4blood: ['Back 4 Blood', 924970],
  dyinglight: ['Dying Light', 239140],
  dyinglight2: ['Dying Light 2 Stay Human', 534380],
  borderlands3: ['Borderlands 3', 397540],
  bl3: ['Borderlands 3', 397540],
  borderlands2: ['Borderlands 2', 49520],
  bl2: ['Borderlands 2', 49520],
  bioshockinfinite: ['BioShock Infinite', 8870],
  tinytinaswonderlands: ["Tiny Tina's Wonderlands", 1286680],
  control: ['Control Ultimate Edition', 870780],
  alanwake: ['Alan Wake', null],
  quantumbreak: ['Quantum Break', 474960],
  sunsetoverdrive: ['Sunset Overdrive', 847370],
  dyinglightthebeast: ['Dying Light: The Beast', null],
  residentevil2: ['Resident Evil 2', 883710],
  re2: ['Resident Evil 2', 883710],
  residentevil3: ['Resident Evil 3', 952060],
  re3: ['Resident Evil 3', 952060],
  residentevil4: ['Resident Evil 4', 2050650],
  re4: ['Resident Evil 4', 2050650],
  residentevil7: ['Resident Evil 7 Biohazard', 418370],
  re7: ['Resident Evil 7 Biohazard', 418370],
  residentevilvillage: ['Resident Evil Village', 1196590],
  re8: ['Resident Evil Village', 1196590],
  revillage: ['Resident Evil Village', 1196590],
  silenthill2: ['SILENT HILL 2', 2124490],
  sh2: ['SILENT HILL 2', 2124490],
  deadspace: ['Dead Space', null],
  deadspaceremake: ['Dead Space', 1693980],
  outlast: ['Outlast', 238320],
  soma: ['SOMA', 282140],
  alienisolation: ['Alien: Isolation', 214490],
  visage: ['VISAGE', 594330],
  themedium: ['The Medium', 1293160],
  hitman3: ['HITMAN 3', 1659040],
  metalgearsolidv: ['METAL GEAR SOLID V: THE PHANTOM PAIN', 287700],
  mgsv: ['METAL GEAR SOLID V: THE PHANTOM PAIN', 287700],
  deathstranding2: ['DEATH STRANDING 2: ON THE BEACH', null],
  forzahorizon5: ['Forza Horizon 5', 1551360],
  fh5: ['Forza Horizon 5', 1551360],
  forzahorizon4: ['Forza Horizon 4', null],
  assettocorsa: ['Assetto Corsa', 244210],
  assettocorsacompetizione: ['Assetto Corsa Competizione', 805550],
  beamngdrive: ['BeamNG.drive', 284160],
  beamng: ['BeamNG.drive', 284160],
  eurotrucksimulator2: ['Euro Truck Simulator 2', 227300],
  ets2: ['Euro Truck Simulator 2', 227300],
  americantrucksimulator: ['American Truck Simulator', 270880],
  ats: ['American Truck Simulator', 270880],
  snowrunner: ['SnowRunner', 1465360],
  farmingsimulator22: ['Farming Simulator 22', 1248130],
  fs22: ['Farming Simulator 22', 1248130],
  wreckfest: ['Wreckfest', 228380],
  descenders: ['Descenders', 681280],
  dirtrally2: ['DiRT Rally 2.0', 690790],
  microsoftflightsimulator: ['Microsoft Flight Simulator', 1250410],
  flightsimulator: ['Microsoft Flight Simulator', 1250410],
  msfs2020: ['Microsoft Flight Simulator', 1250410],
  footballmanager2024: ['Football Manager 2024', 2252570],
  fm24: ['Football Manager 2024', 2252570],
  rocketleague: ['Rocket League', null],
  fallguys: ['Fall Guys', null],
  fortnite: ['Fortnite', null],
  valorant: ['Valorant', null],
  leagueoflegends: ['League of Legends', null],
  overwatch2: ['Overwatch 2', 2357570],
  ow2: ['Overwatch 2', 2357570],
  streetfighter6: ['Street Fighter 6', 1364780],
  sf6: ['Street Fighter 6', 1364780],
  tekken8: ['TEKKEN 8', 1778820],
  mortalkombat11: ['Mortal Kombat 11', 976310],
  mk11: ['Mortal Kombat 11', 976310],
  brawlhalla: ['Brawlhalla', 291550],
  multiversus: ['MultiVersus', 1818750],
  hades: ['Hades', 1145360],
  hades2: ['Hades II', 1145350],
  hollowknight: ['Hollow Knight', 367520],
  hollowknightsilksong: ['Hollow Knight: Silksong', 1030300],
  silksong: ['Hollow Knight: Silksong', 1030300],
  celeste: ['Celeste', 504230],
  oriandthewillofthewisps: ['Ori and the Will of the Wisps', 1057090],
  cuphead: ['Cuphead', 268910],
  deadcells: ['Dead Cells', 588650],
  slaythespire: ['Slay the Spire', 646570],
  balatro: ['Balatro', 2379780],
  vampiresurvivors: ['Vampire Survivors', 1794680],
  tunic: ['TUNIC', 553420],
  deathsdoor: ["Death's Door", 894020],
  darkestdungeon: ['Darkest Dungeon', 262060],
  darkestdungeon2: ['Darkest Dungeon II', 1940340],
  loophero: ['Loop Hero', 1282730],
  papersplease: ['Papers, Please', 239030],
  ftl: ['FTL: Faster Than Light', 212680],
  cultofthelamb: ['Cult of the Lamb', 1313140],
  davethediver: ['DAVE THE DIVER', 1868140],
  dredge: ['DREDGE', null],
  ittakestwo: ['It Takes Two', 1426210],
  awayout: ['A Way Out', 1222700],
  humanfallflat: ['Human: Fall Flat', 477160],
  gangbeasts: ['Gang Beasts', 285900],
  partyanimals: ['Party Animals', 1260320],
  pummelparty: ['Pummel Party', 880940],
  overcooked2: ['Overcooked! 2', 728880],
  plateup: ['PlateUp!', 1599600],
  escapesimulator: ['Escape Simulator', 1435790],
  keeptalkingandnobodyexplodes: ['Keep Talking and Nobody Explodes', 341800],
  totallyaccuratebattlesimulator: ['Totally Accurate Battle Simulator', 508440],
  goatsimulator: ['Goat Simulator', 265930],
  powerwashsimulator: ['PowerWash Simulator', 1290000],
  duckgame: ['Duck Game', 312530],
  golfwithyourfriends: ['Golf With Your Friends', 431240],
  totalwarwarhammer2: ['Total War: WARHAMMER II', null],
  commandandconquerremastered: ['Command & Conquer Remastered Collection', null],
  ageofmythologyretold: ['Age of Mythology: Retold', null],
  stalker2: ['S.T.A.L.K.E.R. 2: Heart of Chornobyl', 1643320],
  atomicheart: ['Atomic Heart', 668580],
  metroexodus: ['Metro Exodus', null],
  liesofp: ['Lies of P', 1627720],
  remnant2: ['Remnant II', 1282100],
  dragonsdogma2: ["Dragon's Dogma 2", 2054970],
  dd2: ["Dragon's Dogma 2", 2054970],
  nioh2: ['Nioh 2 - The Complete Edition', 1325200],
  riskofrain2: ['Risk of Rain 2', 632360],
  barotrauma: ['Barotrauma', 602960],
  starwarsjedifallenorder: ['STAR WARS Jedi: Fallen Order', 1172380],
  jedifallenorder: ['STAR WARS Jedi: Fallen Order', 1172380],
  starwarsjedisurvivor: ['STAR WARS Jedi: Survivor', 1774580],
  jedisurvivor: ['STAR WARS Jedi: Survivor', 1774580],
  starwarsbattlefront2: ['STAR WARS Battlefront II', 1237950],
  hogwartslegacy: ['Hogwarts Legacy', 990080],
  batmanarkhamknight: ['Batman: Arkham Knight', 208650],
  middleearthshadowofwar: ['Middle-earth: Shadow of War', 356190],
  shadowofwar: ['Middle-earth: Shadow of War', 356190],
  middleearthshadowofmordor: ['Middle-earth: Shadow of Mordor', 241930],
  mafiadefinitiveedition: ['Mafia: Definitive Edition', 1030840],
  sleepingdogs: ['Sleeping Dogs: Definitive Edition', 307690],
  farcry3: ['Far Cry 3', 220240],
  farcry5: ['Far Cry 5', 552520],
  farcry6: ['Far Cry 6', null],
  watchdogs2: ['Watch Dogs 2', 447040],
  wd2: ['Watch Dogs 2', 447040],
  rainbowsixsiege: ["Tom Clancy's Rainbow Six Siege", 359550],
  forhonor: ['For Honor', 304390],
  thecrew: ['The Crew', null],
  assassinscreedorigins: ["Assassin's Creed Origins", 582160],
  acorigins: ["Assassin's Creed Origins", 582160],
  assassinscreedodyssey: ["Assassin's Creed Odyssey", 812140],
  acodyssey: ["Assassin's Creed Odyssey", 812140],
  assassinscreedvalhalla: ["Assassin's Creed Valhalla", null],
  acvalhalla: ["Assassin's Creed Valhalla", null],
  assassinscreedmirage: ["Assassin's Creed Mirage", null],
  acmirage: ["Assassin's Creed Mirage", null],
  assassinscreedshadows: ["Assassin's Creed Shadows", null],
  acshadows: ["Assassin's Creed Shadows", null],
  tombraider2013: ['Tomb Raider', 203160],
  riseofthetombraider: ['Rise of the Tomb Raider', 391220],
  shadowofthetombraider: ['Shadow of the Tomb Raider', 750920],
  justcause3: ['Just Cause 3', null],
  justcause4: ['Just Cause 4', null],
  saintsrowthethird: ['Saints Row: The Third Remastered', null],
  everspace2: ['EVERSPACE 2', 1128920],
  elitedangerous: ['Elite Dangerous', 359320],
  eveonline: ['EVE Online', 8500],
  seaofstars: ['Sea of Stars', 1244090],
  clairobscurexpedition33: ['Clair Obscur: Expedition 33', null],
  splitfiction: ['Split Fiction', null],
  thehuntercallofthewild: ['theHunter: Call of the Wild', 518790],
  scrapmechanic: ['Scrap Mechanic', 387990],
  besiege: ['Besiege', 346010],
  detroitbecomehuman: ['Detroit: Become Human', 1222140],
  guardiansofthegalaxy: ["Marvel's Guardians of the Galaxy", 1088850],
  sonicmania: ['Sonic Mania', 584400],
  sonicfrontiers: ['Sonic Frontiers', 1237320],
  bayonetta: ['Bayonetta', 460790],
};

const EXE_ALIASES = {
  eldenring: ['ELDEN RING', 1245620],
  witcher3: ['The Witcher 3: Wild Hunt', 292030],
  cyberpunk2077: ['Cyberpunk 2077', 1091500],
  rdr2: ['Red Dead Redemption 2', 1174180],
  gta5: ['Grand Theft Auto V', 271590],
  stardewvalley: ['Stardew Valley', 413150],
  minecraft: ['Minecraft', null],
  factorio: ['Factorio', 427520],
  terraria: ['Terraria', 105600],
  hades: ['Hades', 1145360],
  hollowknight: ['Hollow Knight', 367520],
  celeste: ['Celeste', 504230],
  cuphead: ['Cuphead', 268910],
  deadcells: ['Dead Cells', 588650],
  balatro: ['Balatro', 2379780],
  sekiro: ['Sekiro: Shadows Die Twice', 814380],
  skyrimse: ['The Elder Scrolls V: Skyrim Special Edition', 489830],
  fallout4: ['Fallout 4', 377160],
  starfield: ['Starfield', 1716740],
  baldursgate3: ["Baldur's Gate 3", 1086940],
  bg3: ["Baldur's Gate 3", 1086940],
  palworld: ['Palworld', 1623730],
  valheim: ['Valheim', 892970],
  raft: ['Raft', 648800],
  amongus: ['Among Us', 945360],
  lethalcompany: ['Lethal Company', 1966720],
  peak: ['PEAK', null],
  repo: ['R.E.P.O.', null],
  schedule: ['Schedule I', null],
  fortnite: ['Fortnite', null],
  valorant: ['Valorant', null],
  leagueclient: ['League of Legends', null],
  rocketleague: ['Rocket League', null],
  osu: ['osu!', null],
  genshinimpact: ['Genshin Impact', null],
  starrail: ['Honkai: Star Rail', null],
  witcher2: ['The Witcher 2: Assassins of Kings', 20920],
  portal2: ['Portal 2', 620],
  halflife2: ['Half-Life 2', 220],
  left4dead2: ['Left 4 Dead 2', 550],
  dontstarve: ["Don't Starve Together", 322330],
  projectzomboid: ['Project Zomboid', 108600],
  rimworld: ['RimWorld', 294100],
  oxygennotincluded: ['Oxygen Not Included', 457140],
  frostpunk: ['Frostpunk', 323190],
  cities: ['Cities: Skylines', 255710],
  stellaris: ['Stellaris', 281990],
  crusaderkings3: ['Crusader Kings III', 1158310],
  civilization6: ["Sid Meier's Civilization VI", 289070],
  ageofempires4: ['Age of Empires IV: Anniversary Edition', 1466860],
  doometernal: ['DOOM Eternal', 782330],
  deathstranding: ['DEATH STRANDING DIRECTOR’S CUT', 1190460],
  ghostoftsushima: ["Ghost of Tsushima DIRECTOR'S CUT", 2215430],
  spiderman: ["Marvel's Spider-Man Remastered", 1817070],
  godofwar: ['God of War', 1593500],
  tlou: ['The Last of Us Part I', 1888930],
  forzahorizon5: ['Forza Horizon 5', 1551360],
  farmingsimulator22: ['Farming Simulator 22', 1248130],
  eurotrucksimulator2: ['Euro Truck Simulator 2', 227300],
  residentevil4: ['Resident Evil 4', 2050650],
  residentevil2: ['Resident Evil 2', 883710],
  silenthill2: ['SILENT HILL 2', 2124490],
  dyinglight2: ['Dying Light 2 Stay Human', 534380],
  borderlands3: ['Borderlands 3', 397540],
  bioshockinfinite: ['BioShock Infinite', 8870],
  control: ['Control Ultimate Edition', 870780],
  farcry5: ['Far Cry 5', 552520],
  watchdogs2: ['Watch Dogs 2', 447040],
  assassinscreedodyssey: ["Assassin's Creed Odyssey", 812140],
  tombraider: ['Tomb Raider', 203160],
  riseofthetombraider: ['Rise of the Tomb Raider', 391220],
  shadowofthetombraider: ['Shadow of the Tomb Raider', 750920],
  yakuza0: ['Yakuza 0', 638970],
  persona5royal: ['Persona 5 Royal', 1687950],
  nierautomata: ['NieR:Automata', 524220],
  monsterhunterworld: ['Monster Hunter: World', 582010],
  stalker2: ['S.T.A.L.K.E.R. 2: Heart of Chornobyl', 1643320],
  atomicheart: ['Atomic Heart', 668580],
  liesofp: ['Lies of P', 1627720],
  remnant2: ['Remnant II', 1282100],
  dragonsdogma2: ["Dragon's Dogma 2", 2054970],
  riskofrain2: ['Risk of Rain 2', 632360],
  hogwartslegacy: ['Hogwarts Legacy', 990080],
  ittakestwo: ['It Takes Two', 1426210],
  overcooked2: ['Overcooked! 2', 728880],
  plateup: ['PlateUp!', 1599600],
  vampiresurvivors: ['Vampire Survivors', 1794680],
  slaythespire: ['Slay the Spire', 646570],
  darkestdungeon: ['Darkest Dungeon', 262060],
  tunic: ['TUNIC', 553420],
  cultofthelamb: ['Cult of the Lamb', 1313140],
  davethediver: ['DAVE THE DIVER', 1868140],
};

const EXE_SUFFIX_STRIP = /(-?win64-?shipping|-?win32-?shipping|-?shipping|client|launcher|game|app|x64|x86|win64|win32|64|exe)+$/;

function normalizeKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fifaTitle(num) {
  return /^\d{2}$|^\d{4}$/.test(num) ? `EA SPORTS FIFA ${num}` : null;
}

const COD_SUFFIXES = {
  mw: 'Modern Warfare', mw2: 'Modern Warfare 2', mw3: 'Modern Warfare 3',
  bo: 'Black Ops', bo2: 'Black Ops II', bo3: 'Black Ops III',
  bo4: 'Black Ops 4', bo6: 'Black Ops 6', bo7: 'Black Ops 7',
  coldwar: 'Black Ops Cold War', cw: 'Black Ops Cold War',
  vanguard: 'Vanguard', mwii: 'Modern Warfare II', mw2022: 'Modern Warfare II',
  mwiii: 'Modern Warfare III', mw2023: 'Modern Warfare III',
  ghosts: 'Ghosts', aw: 'Advanced Warfare', iw: 'Infinite Warfare',
  wwii: 'WWII', ww2: 'WWII', warzone: 'Warzone', wz: 'Warzone',
  mobile: 'Mobile', modernwarfare: 'Modern Warfare',
  blackops: 'Black Ops', blackops2: 'Black Ops II',
};

const AC_TITLES = {
  origins: ["Assassin's Creed Origins", 582160],
  odyssey: ["Assassin's Creed Odyssey", 812140],
  valhalla: ["Assassin's Creed Valhalla", null],
  mirage: ["Assassin's Creed Mirage", null],
  shadows: ["Assassin's Creed Shadows", null],
  unity: ["Assassin's Creed Unity", null],
  syndicate: ["Assassin's Creed Syndicate", null],
  blackflag: ["Assassin's Creed IV: Black Flag", null],
  rogue: ["Assassin's Creed Rogue", null],
  liberation: ["Assassin's Creed Liberation", null],
  revelations: ["Assassin's Creed Revelations", null],
};

const TOMB_RAIDER = {
  2013: ['Tomb Raider', 203160],
  rise: ['Rise of the Tomb Raider', 391220],
  riseofthetombraider: ['Rise of the Tomb Raider', 391220],
  shadow: ['Shadow of the Tomb Raider', 750920],
  shadowofthetombraider: ['Shadow of the Tomb Raider', 750920],
};

function patternIdentity(key) {
  let m = key.match(/^fifa(\d{2,4})$/);
  if (m) {
    const t = fifaTitle(m[1]);
    if (t) return { title: t, steamAppid: null, confidence: 0.8, method: 'pattern' };
  }
  m = key.match(/^fc(\d{2})$/);
  if (m) return { title: `EA SPORTS FC ${m[1]}`, steamAppid: null, confidence: 0.8, method: 'pattern' };
  m = key.match(/^cod[_-]*(.+)$/);
  if (m) {
    const suf = COD_SUFFIXES[m[1]] || m[1].replace(/_/g, ' ').toUpperCase();
    return { title: `Call of Duty: ${suf}`, steamAppid: null, confidence: 0.8, method: 'pattern' };
  }
  m = key.match(/^ac[_-]*(.+)$/);
  if (m && AC_TITLES[m[1]]) {
    const [t, a] = AC_TITLES[m[1]];
    return { title: t, steamAppid: a, confidence: 0.8, method: 'pattern' };
  }
  m = key.match(/^tombraider[_-]*(.*)$/);
  if (m && TOMB_RAIDER[m[1]]) {
    const [t, a] = TOMB_RAIDER[m[1]];
    return { title: t, steamAppid: a, confidence: 0.8, method: 'pattern' };
  }
  m = key.match(/^gta[_-]*(\d+|[ivxlc]+)$/);
  if (m) return { title: `Grand Theft Auto ${m[1].toUpperCase()}`, steamAppid: null, confidence: 0.75, method: 'pattern' };
  m = key.match(/^nfs[_-]*(.+)$/);
  if (m) {
    const s = m[1].replace(/_/g, ' ').replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1));
    return { title: `Need for Speed: ${s}`, steamAppid: null, confidence: 0.75, method: 'pattern' };
  }
  m = key.match(/^re[_-]*([02478])$/);
  if (m) {
    const table = {
      0: ['Resident Evil 0', null], 2: ['Resident Evil 2', 883710],
      4: ['Resident Evil 4', 2050650], 7: ['Resident Evil 7 Biohazard', 418370],
      8: ['Resident Evil Village', 1196590],
    };
    const [t, a] = table[m[1]];
    return { title: t, steamAppid: a, confidence: 0.8, method: 'pattern' };
  }
  return null;
}

function ident(title, steamAppid, confidence, method) {
  return { title, steamAppid, confidence, method, parsed: method !== 'folder' };
}

// Score exact query-token recall. Extra candidate words do not lower the score.
function titleSimilarity(query, candidate) {
  const q = new Set(String(query).toLowerCase().match(/[a-z0-9]+/g) || []);
  if (!q.size) return 0;
  const c = new Set(String(candidate).toLowerCase().match(/[a-z0-9]+/g) || []);
  let hit = 0;
  for (const t of q) if (c.has(t)) hit++;
  return hit / q.size;
}

// Minimum token recall required for automatic acceptance.
const MIN_TITLE_RECALL = 0.5;

function resolveFolder(folderName, cleanFn) {
  const key = normalizeKey(folderName);
  if (ALIASES[key]) {
    const [t, a] = ALIASES[key];
    return ident(t, a, 0.95, 'alias');
  }
  const cleaned = cleanFn(folderName);
  const key2 = normalizeKey(cleaned);
  if (key2 && key2 !== key && ALIASES[key2]) {
    const [t, a] = ALIASES[key2];
    return ident(t, a, 0.9, 'alias-cleaned');
  }
  let pat = patternIdentity(key);
  if (pat) return ident(pat.title, pat.steamAppid, pat.confidence, pat.method);
  if (key2 && key2 !== key) {
    pat = patternIdentity(key2);
    if (pat) return ident(pat.title, pat.steamAppid, 0.75, pat.method);
  }
  return ident(cleaned || folderName, null, 0.4, 'folder');
}

function resolveExeStem(stem) {
  const key = normalizeKey(stem);
  if (EXE_ALIASES[key]) {
    const [t, a] = EXE_ALIASES[key];
    return ident(t, a, 0.7, 'exe-fallback');
  }
  const short = key.replace(EXE_SUFFIX_STRIP, '');
  if (short && short !== key && EXE_ALIASES[short]) {
    const [t, a] = EXE_ALIASES[short];
    return ident(t, a, 0.65, 'exe-fallback');
  }
  if (short && short !== key && ALIASES[short]) {
    const [t, a] = ALIASES[short];
    return ident(t, a, 0.6, 'exe-fallback');
  }
  if (ALIASES[key]) {
    const [t, a] = ALIASES[key];
    return ident(t, a, 0.6, 'exe-fallback');
  }
  // Retry once after removing a trailing release-group name.
  const chopped = strips.stripTrailingGroup(key);
  if (chopped && chopped !== key && ALIASES[chopped]) {
    const [t, a] = ALIASES[chopped];
    return ident(t, a, 0.55, 'exe-fallback');
  }
  return null;
}

module.exports = { ALIASES, EXE_ALIASES, normalizeKey, resolveFolder, resolveExeStem, titleSimilarity, MIN_TITLE_RECALL };
