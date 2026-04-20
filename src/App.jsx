import { useState, useEffect, useCallback, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, get, update, onValue, push } from "firebase/database";

// ── Firebase ──────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyCWlZWWRg5q3MtD7R7se21yNeUszR4iLVY",
  authDomain: "catan-bg-v1.firebaseapp.com",
  databaseURL: "https://catan-bg-v1-default-rtdb.firebaseio.com",
  projectId: "catan-bg-v1",
  storageBucket: "catan-bg-v1.firebasestorage.app",
  messagingSenderId: "821065823540",
  appId: "1:821065823540:web:de051f29e05dcc9d1fe161",
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ── Constants ─────────────────────────────────────────────────────────────────
const COLORS = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c"];
const COLOR_NAMES = ["Red","Blue","Green","Orange","Purple","Teal"];
const RESOURCE_COLORS = {
  wood:   "#5D4037", brick: "#BF360C", sheep: "#7CB342",
  wheat:  "#F9A825", ore:   "#78909C", desert: "#D7CCC8",
};
const RESOURCE_EMOJI = { wood:"🌲", brick:"🧱", sheep:"🐑", wheat:"🌾", ore:"⛏️", desert:"🏜️" };
const TILE_COUNTS_BASE   = { wood:4, brick:3, sheep:4, wheat:4, ore:3, desert:1 };
const TILE_COUNTS_EXT    = { wood:6, brick:5, sheep:6, wheat:6, ore:5, desert:2 };
const NUMBER_TOKENS_BASE = [2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12];
const NUMBER_TOKENS_EXT  = [2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12,2,3,4,5,6,8,9,10,11,12];
const PORT_TYPES = ["3:1","3:1","3:1","3:1","wood","brick","sheep","wheat","ore"];
const PORT_TYPES_EXT = [...PORT_TYPES,"3:1","3:1"];

// Building costs
const COSTS = {
  road:       { wood:1, brick:1 },
  settlement: { wood:1, brick:1, sheep:1, wheat:1 },
  city:       { wheat:2, ore:3 },
  devCard:    { sheep:1, wheat:1, ore:1 },
};

const DEV_CARDS = [
  ...Array(14).fill("knight"),
  ...Array(5).fill("victoryPoint"),
  ...Array(2).fill("roadBuilding"),
  ...Array(2).fill("yearOfPlenty"),
  ...Array(2).fill("monopoly"),
];

// ── Hex Grid Layout ───────────────────────────────────────────────────────────
// Standard Catan board: rows of 3-4-5-4-3 hexes
const BASE_LAYOUT  = [3,4,5,4,3];
const EXT_LAYOUT   = [3,4,5,6,5,4,3]; // approximate 5-6 extension

function generateHexGrid(layout) {
  const tiles = [];
  const totalRows = layout.length;
  const midRow = Math.floor(totalRows / 2);
  let id = 0;
  for (let row = 0; row < totalRows; row++) {
    const cols = layout[row];
    const offset = midRow - row;
    for (let col = 0; col < cols; col++) {
      tiles.push({ id: id++, row, col, offset });
    }
  }
  return tiles;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateBoard(playerCount) {
  const ext = playerCount >= 5;
  const layout = ext ? EXT_LAYOUT : BASE_LAYOUT;
  const tileCounts = ext ? TILE_COUNTS_EXT : TILE_COUNTS_BASE;
  const numberTokens = ext ? [...NUMBER_TOKENS_EXT] : [...NUMBER_TOKENS_BASE];
  const portTypes = ext ? [...PORT_TYPES_EXT] : [...PORT_TYPES];

  // Build resource pool
  const resources = [];
  for (const [res, count] of Object.entries(tileCounts)) {
    for (let i = 0; i < count; i++) resources.push(res);
  }
  const shuffledRes = shuffle(resources);
  const shuffledNums = shuffle(numberTokens);
  const shuffledPorts = shuffle(portTypes);

  const hexes = generateHexGrid(layout);
  let numIdx = 0;
  const tileData = hexes.map((hex, i) => {
    const resource = shuffledRes[i];
    const number = resource === "desert" ? null : shuffledNums[numIdx++];
    return { ...hex, resource, number, hasRobber: resource === "desert" };
  });

  // Generate vertices & edges (logical, keyed by position)
  // We'll compute pixel positions at render time
  return {
    tiles: tileData,
    layout,
    ports: shuffledPorts,
    robberTile: tileData.find(t => t.resource === "desert")?.id ?? 0,
  };
}

// ── Pixel Layout Helpers ──────────────────────────────────────────────────────
const HEX_SIZE = 52; // radius
const HW = HEX_SIZE * Math.sqrt(3);
const HH = HEX_SIZE * 1.5;

function hexCenter(tile, layout) {
  const totalRows = layout.length;
  const midRow = Math.floor(totalRows / 2);
  const cols = layout[tile.row];
  const maxCols = Math.max(...layout);
  const startX = ((maxCols - cols) / 2) * HW;
  const x = startX + tile.col * HW + HW / 2;
  const y = tile.row * HH + HEX_SIZE;
  return { x, y };
}

function hexCorners(cx, cy, size) {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 180) * (60 * i - 30);
    return { x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) };
  });
}

// Build vertex/edge maps from tile geometry
function buildGraph(tiles, layout) {
  const SNAP = 8;
  const vertMap = {}; // key -> vertex id
  const verts = [];
  const edges = [];
  const edgeMap = {};

  function snapKey(x, y) {
    return `${Math.round(x / SNAP) * SNAP},${Math.round(y / SNAP) * SNAP}`;
  }

  function getVertex(x, y) {
    const k = snapKey(x, y);
    if (vertMap[k] === undefined) {
      vertMap[k] = verts.length;
      verts.push({ id: verts.length, x, y, building: null, owner: null, adjacentTiles: [] });
    }
    return vertMap[k];
  }

  tiles.forEach(tile => {
    const { x: cx, y: cy } = hexCenter(tile, layout);
    const corners = hexCorners(cx, cy, HEX_SIZE - 2);
    const vIds = corners.map(c => getVertex(c.x, c.y));
    vIds.forEach(vid => {
      if (!verts[vid].adjacentTiles.includes(tile.id)) {
        verts[vid].adjacentTiles.push(tile.id);
      }
    });
    // edges between consecutive corners
    for (let i = 0; i < 6; i++) {
      const a = vIds[i], b = vIds[(i + 1) % 6];
      const ek = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!edgeMap[ek]) {
        edgeMap[ek] = edges.length;
        edges.push({ id: edges.length, v1: a, v2: b, road: null, adjacentTiles: [tile.id] });
      } else {
        const eid = edgeMap[ek];
        if (!edges[eid].adjacentTiles.includes(tile.id)) {
          edges[eid].adjacentTiles.push(tile.id);
        }
      }
    }
  });

  // adjacency lists for vertices
  verts.forEach(v => { v.adjacentVerts = []; v.adjacentEdges = []; });
  edges.forEach(e => {
    verts[e.v1].adjacentVerts.push(e.v2);
    verts[e.v2].adjacentVerts.push(e.v1);
    verts[e.v1].adjacentEdges.push(e.id);
    verts[e.v2].adjacentEdges.push(e.id);
  });

  return { verts, edges };
}

// ── Longest Road ─────────────────────────────────────────────────────────────
function computeLongestRoad(edges, verts, playerIdx) {
  const playerEdges = edges.filter(e => e.road === playerIdx);
  if (playerEdges.length === 0) return 0;
  const edgeSet = new Set(playerEdges.map(e => e.id));
  let best = 0;

  function dfs(vId, prevEdgeId, visited) {
    let max = visited.size;
    const v = verts[vId];
    for (const eid of v.adjacentEdges) {
      if (!edgeSet.has(eid) || visited.has(eid)) continue;
      const e = edges[eid];
      const nextV = e.v1 === vId ? e.v2 : e.v1;
      // can traverse through enemy settlements? No — break if opponent has building
      const nextVert = verts[nextV];
      if (nextVert.owner !== null && nextVert.owner !== playerIdx && prevEdgeId !== null) continue;
      visited.add(eid);
      const len = dfs(nextV, eid, visited);
      if (len > max) max = len;
      visited.delete(eid);
    }
    return max;
  }

  for (const e of playerEdges) {
    const r1 = dfs(e.v1, e.id, new Set([e.id]));
    if (r1 > best) best = r1;
    const r2 = dfs(e.v2, e.id, new Set([e.id]));
    if (r2 > best) best = r2;
  }
  return best;
}

// ── Initial Game State ────────────────────────────────────────────────────────
function createInitialGameState(players, playerCount) {
  const board = generateBoard(playerCount);
  const { verts, edges } = buildGraph(board.tiles, board.layout);
  const devDeck = shuffle([...DEV_CARDS]);

  return {
    phase: "setup",          // setup | main | ended
    setupTurn: 0,            // counts placements 0..2n-1
    setupRound: 1,
    currentPlayer: 0,
    players: players.map((p, i) => ({
      ...p,
      index: i,
      resources: { wood:0, brick:0, sheep:0, wheat:0, ore:0 },
      devCards: [],
      roads: 0,
      settlements: 0,
      cities: 0,
      victoryPoints: 0,
      knights: 0,
      longestRoad: 0,
      hasLargestArmy: false,
      hasLongestRoad: false,
    })),
    board,
    verts: verts.map(v => ({ ...v })),
    edges: edges.map(e => ({ ...e })),
    devDeck,
    devDeckSize: devDeck.length,
    longestRoadPlayer: null,
    largestArmyPlayer: null,
    diceRoll: null,
    robberMoved: false,
    tradeOffer: null,
    mustDiscard: [],
    buildingPhase: false, // 5-6 player special building phase
    log: [],
    winner: null,
    swapMode: false,
    swapTile: null,
  };
}

// ── App Root ──────────────────────────────────────────────────────────────────
export default function CatanApp() {
  const [screen, setScreen] = useState("lobby"); // lobby | waiting | game
  const [roomId, setRoomId] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [myName, setMyName] = useState("");
  const [myIndex, setMyIndex] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [error, setError] = useState("");
  const [playerCount, setPlayerCount] = useState(4);
  const gameRef = useRef(null);

  // Subscribe to game state
  useEffect(() => {
    if (!roomId) return;
    const r = ref(db, `games/${roomId}`);
    gameRef.current = r;
    const unsub = onValue(r, snap => {
      const val = snap.val();
      if (val) {
        setGameState(val);
        // FIX: Auto-transition other players when the host starts the game
        if (val.status === "playing" && screen !== "game") {
          setScreen("game");
        }
      }
    });
    return () => unsub();
  }, [roomId, screen]);

  async function createRoom() {
    if (!myName.trim()) { setError("Enter your name"); return; }
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    const player = { name: myName.trim(), color: COLORS[0], colorName: COLOR_NAMES[0], index: 0, isHost: true };
    await set(ref(db, `games/${code}`), {
      roomCode: code,
      status: "waiting",
      playerCount,
      players: [player],
      hostIndex: 0,
    });
    setRoomId(code);
    setMyIndex(0);
    setScreen("waiting");
  }

  async function joinRoom() {
    if (!myName.trim()) { setError("Enter your name"); return; }
    if (!joinCode.trim()) { setError("Enter room code"); return; }
    const code = joinCode.trim().toUpperCase();
    const snap = await get(ref(db, `games/${code}`));
    if (!snap.exists()) { setError("Room not found"); return; }
    const data = snap.val();
    
    const players = data.players || [];

    // FIX: Allow players to rejoin a game in progress if they get disconnected/refresh
    if (data.status !== "waiting") { 
      const existingPlayer = players.find(p => p.name.toLowerCase() === myName.trim().toLowerCase());
      if (existingPlayer) {
        setRoomId(code);
        setMyIndex(existingPlayer.index);
        setScreen("game");
        return;
      }
      setError("Game already started. If you are trying to reconnect, use your exact original name."); 
      return; 
    }
    
    if (players.length >= data.playerCount) { setError("Room is full"); return; }
    const idx = players.length;
    const newPlayer = { name: myName.trim(), color: COLORS[idx], colorName: COLOR_NAMES[idx], index: idx, isHost: false };
    const updated = [...players, newPlayer];
    await update(ref(db, `games/${code}`), { players: updated });
    setRoomId(code);
    setMyIndex(idx);
    setScreen("waiting");
  }

  async function startGame() {
    const snap = await get(ref(db, `games/${roomId}`));
    const data = snap.val();
    const gs = createInitialGameState(data.players, data.playerCount);
    await update(ref(db, `games/${roomId}`), { status: "playing", ...gs });
    setScreen("game");
  }

  async function updateGS(patch) {
    await update(ref(db, `games/${roomId}`), patch);
  }

  if (screen === "lobby") return (
    <Lobby
      myName={myName} setMyName={setMyName}
      joinCode={joinCode} setJoinCode={setJoinCode}
      playerCount={playerCount} setPlayerCount={setPlayerCount}
      onCreate={createRoom} onJoin={joinRoom} error={error}
    />
  );

  if (screen === "waiting") return (
    <WaitingRoom
      gameState={gameState} myIndex={myIndex} roomId={roomId}
      onStart={startGame}
    />
  );

  if (!gameState || gameState.status === "waiting") return (
    <div style={styles.center}><p style={{color:"#fff"}}>Connecting…</p></div>
  );

  if (gameState.status === "playing" || gameState.status === "ended") return (
    <GameBoard
      gs={gameState} myIndex={myIndex} updateGS={updateGS} roomId={roomId}
    />
  );

  return null;
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
function Lobby({ myName, setMyName, joinCode, setJoinCode, playerCount, setPlayerCount, onCreate, onJoin, error }) {
  return (
    <div style={styles.lobby}>
      <div style={styles.lobbyCard}>
        <h1 style={styles.title}>🏝️ CATAN</h1>
        <p style={styles.subtitle}>Online Multiplayer — up to 6 players</p>
        <input style={styles.input} placeholder="Your name" value={myName} onChange={e => setMyName(e.target.value)} />
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Create Game</h3>
          <label style={styles.label}>Players</label>
          <select style={styles.select} value={playerCount} onChange={e => setPlayerCount(+e.target.value)}>
            {[3,4,5,6].map(n => <option key={n} value={n}>{n} players{n>=5?" (Extension)":""}</option>)}
          </select>
          <button style={styles.btn} onClick={onCreate}>Create Room</button>
        </div>
        <div style={styles.divider}><span>or</span></div>
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>Join Game</h3>
          <input style={styles.input} placeholder="Room code" value={joinCode}
            onChange={e => setJoinCode(e.target.value.toUpperCase())} maxLength={5} />
          <button style={{...styles.btn, background:"#3498db"}} onClick={onJoin}>Join Room</button>
        </div>
        {error && <p style={styles.error}>{error}</p>}
      </div>
    </div>
  );
}

// ── Waiting Room ──────────────────────────────────────────────────────────────
function WaitingRoom({ gameState, myIndex, roomId, onStart }) {
  const players = gameState?.players || [];
  const targetCount = gameState?.playerCount || 4;
  const isHost = myIndex === 0;
  const canStart = players.length >= 3 && isHost;

  return (
    <div style={styles.lobby}>
      <div style={styles.lobbyCard}>
        <h2 style={styles.title}>Waiting Room</h2>
        <div style={{background:"#1a2a3a", padding:"12px 20px", borderRadius:8, marginBottom:16, textAlign:"center"}}>
          <p style={{color:"#aaa", margin:0, fontSize:13}}>Room Code</p>
          <p style={{color:"#f39c12", fontSize:32, fontWeight:900, letterSpacing:6, margin:0}}>{roomId}</p>
          <p style={{color:"#aaa", margin:0, fontSize:12}}>Share this with friends</p>
        </div>
        <p style={{color:"#aaa", fontSize:13, textAlign:"center"}}>{players.length}/{targetCount} players joined</p>
        {players.map((p, i) => (
          <div key={i} style={{...styles.playerRow, borderLeft:`4px solid ${p.color}`}}>
            <span style={{color:p.color, fontWeight:700}}>●</span>
            <span style={{color:"#fff", marginLeft:10}}>{p.name}</span>
            {i === 0 && <span style={{marginLeft:"auto", color:"#f39c12", fontSize:11}}>HOST</span>}
            {i === myIndex && <span style={{marginLeft:i===0?"8px":"auto", color:"#2ecc71", fontSize:11}}>YOU</span>}
          </div>
        ))}
        {isHost && (
          <button style={{...styles.btn, marginTop:20, opacity: canStart?1:0.5}} onClick={canStart ? onStart : undefined}>
            {canStart ? "Start Game" : `Need at least 3 players (${players.length}/3)`}
          </button>
        )}
        {!isHost && <p style={{color:"#aaa", textAlign:"center", fontSize:13}}>Waiting for host to start…</p>}
      </div>
    </div>
  );
}

// ── Game Board ────────────────────────────────────────────────────────────────
function GameBoard({ gs, myIndex, updateGS, roomId }) {
  const [selectedVert, setSelectedVert] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [action, setAction] = useState(null); // "buildRoad"|"buildSettlement"|"buildCity"|"moveRobber"|"stealFrom"|"roadBuilding"|"yearOfPlenty"|"monopoly"|"swapTile"
  const [pendingRoad, setPendingRoad] = useState(0);
  const [stealTargets, setStealTargets] = useState([]);
  const [tradeRes, setTradeRes] = useState({ wood:0, brick:0, sheep:0, wheat:0, ore:0 });
  const [tradeGet, setTradeGet] = useState("wood");
  const [yearChoices, setYearChoices] = useState([]);
  const [monoRes, setMonoRes] = useState("wood");
  const [discardAmount, setDiscardAmount] = useState({ wood:0, brick:0, sheep:0, wheat:0, ore:0 });
  const [swapFirst, setSwapFirst] = useState(null);

  const isMyTurn = gs.currentPlayer === myIndex;
  const me = gs.players[myIndex];
  const layout = gs.board.layout;

  // SVG dimensions
  const maxCols = Math.max(...layout);
  const svgW = maxCols * HW + HW;
  const svgH = layout.length * HH + HEX_SIZE * 2;

  function log(msg) {
    const newLog = [...(gs.log||[]), `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-40);
    return { log: newLog };
  }

  // ── Setup Phase ──────────────────────────────────────────────────────────
  async function handleSetupVertexClick(vid) {
    if (!isMyTurn) return;
    if (gs.phase !== "setup") return;
    const v = gs.verts[vid];
    // Must not be occupied and not adjacent to occupied
    if (v.building) return;
    const tooClose = v.adjacentVerts.some(av => gs.verts[av].building);
    if (tooClose) return;

    const newVerts = gs.verts.map((vv, i) => i === vid ? { ...vv, building: "settlement", owner: myIndex } : vv);
    const newPlayers = gs.players.map((p, i) => i === myIndex
      ? { ...p, settlements: p.settlements+1, victoryPoints: p.victoryPoints+1 }
      : p
    );

    // In 2nd round, give resources
    let extraRes = {};
    if (gs.setupRound === 2) {
      newVerts[vid].adjacentTiles.forEach(tid => {
        const tile = gs.board.tiles[tid];
        if (tile.resource !== "desert") {
          extraRes[tile.resource] = (extraRes[tile.resource] || 0) + 1;
        }
      });
      Object.keys(extraRes).forEach(r => {
        newPlayers[myIndex].resources[r] = (newPlayers[myIndex].resources[r]||0) + extraRes[r];
      });
    }

    // FIX: Do NOT change players yet. Just switch phase to roadSetup for the current player!
    await updateGS({
      verts: newVerts, 
      players: newPlayers,
      phase: "roadSetup",
      ...log(`${gs.players[myIndex].name} placed a settlement`)
    });
  }

  async function handleSetupEdgeClick(eid) {
    if (!isMyTurn) return;
    if (gs.phase !== "roadSetup") return;
    const e = gs.edges[eid];
    if (e.road !== null) return;
    
    // Must connect to own settlement
    const myVerts = gs.verts.filter(v => v.owner === myIndex);
    const connected = myVerts.some(v => v.adjacentEdges.includes(eid));
    if (!connected) return;

    const newEdges = gs.edges.map((ee, i) => i === eid ? { ...ee, road: myIndex } : ee);
    const newPlayers = gs.players.map((p, i) => i === myIndex ? { ...p, roads: p.roads+1 } : p);

    // FIX: Now that the road is placed, figure out who is next.
    const total = gs.players.length;
    let nextPlayer = gs.currentPlayer;
    let setupRound = gs.setupRound;
    let phase = "setup";
    let setupTurn = gs.setupTurn + 1;

    // Snake draft order logic
    if (gs.setupRound === 1) {
      if (gs.currentPlayer < total - 1) {
        nextPlayer = gs.currentPlayer + 1;
      } else {
        nextPlayer = total - 1; // Last player gets two turns in a row
        setupRound = 2;
      }
    } else {
      if (gs.currentPlayer > 0) {
        nextPlayer = gs.currentPlayer - 1;
      } else {
        phase = "main"; // Setup is complete!
        nextPlayer = 0; // Player 1 starts the real game
      }
    }

    await updateGS({
      edges: newEdges, 
      players: newPlayers,
      currentPlayer: nextPlayer, 
      setupRound,
      setupTurn,
      phase,
      ...log(`${gs.players[myIndex].name} placed a road`)
    });
  }

  // ── Dice ────────────────────────────────────────────────────────────────
  async function rollDice() {
    if (!isMyTurn || gs.phase !== "main" || gs.diceRoll !== null) return;
    const d1 = Math.ceil(Math.random()*6), d2 = Math.ceil(Math.random()*6);
    const roll = d1 + d2;

    let newPlayers = gs.players.map(p => ({ ...p }));
    let mustDiscard = [];

    if (roll === 7) {
      // Check who must discard (>7 cards)
      gs.players.forEach((p, i) => {
        const total = Object.values(p.resources).reduce((a,b)=>a+b,0);
        if (total > 7) mustDiscard.push(i);
      });
      await updateGS({
        diceRoll: [d1, d2],
        robberMoved: false,
        mustDiscard,
        ...log(`${me.name} rolled ${roll} — Robber!`)
      });
    } else {
      // Distribute resources
      gs.board.tiles.forEach(tile => {
        if (tile.number !== roll || tile.hasRobber) return;
        gs.verts.forEach(v => {
          if (v.adjacentTiles.includes(tile.id) && v.owner !== null && v.building) {
            const amount = v.building === "city" ? 2 : 1;
            newPlayers[v.owner].resources[tile.resource] = (newPlayers[v.owner].resources[tile.resource]||0) + amount;
          }
        });
      });
      await updateGS({
        diceRoll: [d1, d2], players: newPlayers,
        ...log(`${me.name} rolled ${roll}`)
      });
    }
  }

  // ── Robber ──────────────────────────────────────────────────────────────
  async function handleRobberTileClick(tid) {
    if (!isMyTurn || action !== "moveRobber") return;
    if (tid === gs.board.robberTile) return; // must move
    const newTiles = gs.board.tiles.map(t => ({ ...t, hasRobber: t.id === tid }));

    // Find opponents on adjacent vertices
    const adjVerts = gs.verts.filter(v => v.adjacentTiles.includes(tid) && v.owner !== null && v.owner !== myIndex);
    const targets = [...new Set(adjVerts.map(v => v.owner))];

    if (targets.length > 0) {
      setStealTargets(targets);
      setAction("stealFrom");
      await updateGS({ board: { ...gs.board, tiles: newTiles }, robberTile: tid });
    } else {
      setAction(null);
      await updateGS({
        board: { ...gs.board, tiles: newTiles }, robberTile: tid, robberMoved: true,
        ...log(`${me.name} moved the robber`)
      });
    }
  }

  async function stealFrom(targetIdx) {
    const target = gs.players[targetIdx];
    const resources = Object.entries(target.resources).filter(([,v]) => v > 0).map(([r]) => r);
    if (resources.length === 0) { setAction(null); setStealTargets([]); return; }
    const stolen = resources[Math.floor(Math.random() * resources.length)];
    const newPlayers = gs.players.map((p, i) => {
      if (i === myIndex) return { ...p, resources: { ...p.resources, [stolen]: p.resources[stolen]+1 }};
      if (i === targetIdx) return { ...p, resources: { ...p.resources, [stolen]: p.resources[stolen]-1 }};
      return p;
    });
    setAction(null); setStealTargets([]);
    await updateGS({ players: newPlayers, robberMoved: true, ...log(`${me.name} stole 1 ${stolen}`) });
  }

  // ── Building ────────────────────────────────────────────────────────────
  function canAfford(cost) {
    return Object.entries(cost).every(([r, n]) => (me.resources[r]||0) >= n);
  }

  async function buildRoadAt(eid) {
    if (gs.edges[eid].road !== null) return;
    const e = gs.edges[eid];
    // Must connect to own road or settlement
    const myVertsIds = gs.verts.filter(v => v.owner === myIndex).map(v => v.id);
    const myEdgeIds = gs.edges.filter(e => e.road === myIndex).map(e => e.id);
    const connected = [e.v1, e.v2].some(v => myVertsIds.includes(v)) ||
      gs.verts[e.v1].adjacentEdges.some(ae => myEdgeIds.includes(ae)) ||
      gs.verts[e.v2].adjacentEdges.some(ae => myEdgeIds.includes(ae));
    if (!connected) return;

    const isFree = action === "roadBuilding";
    if (!isFree && !canAfford(COSTS.road)) return;

    const newEdges = gs.edges.map((ee, i) => i === eid ? { ...ee, road: myIndex } : ee);
    let newPlayers = gs.players.map((p, i) => {
      if (i !== myIndex) return p;
      const res = isFree ? p.resources : Object.fromEntries(Object.entries(p.resources).map(([r,v]) => [r, v - (COSTS.road[r]||0)]));
      return { ...p, resources: res, roads: p.roads+1 };
    });

    // Recompute longest road
    const lr = computeLongestRoad(newEdges, gs.verts, myIndex);
    newPlayers[myIndex].longestRoad = lr;
    let longestRoadPlayer = gs.longestRoadPlayer;
    if (lr >= 5) {
      if (longestRoadPlayer === null || longestRoadPlayer !== myIndex) {
        const current = longestRoadPlayer !== null ? newPlayers[longestRoadPlayer].longestRoad : 0;
        if (lr > current) {
          if (longestRoadPlayer !== null) {
            newPlayers[longestRoadPlayer].hasLongestRoad = false;
            newPlayers[longestRoadPlayer].victoryPoints -= 2;
          }
          newPlayers[myIndex].hasLongestRoad = true;
          newPlayers[myIndex].victoryPoints += 2;
          longestRoadPlayer = myIndex;
        }
      }
    }

    let newAction = null;
    if (action === "roadBuilding") {
      const rem = pendingRoad - 1;
      setPendingRoad(rem);
      if (rem > 0) newAction = "roadBuilding";
    }
    setAction(newAction);

    await updateGS({ edges: newEdges, players: newPlayers, longestRoadPlayer, ...log(`${me.name} built a road`) });
  }

  async function buildSettlementAt(vid) {
    if (!isMyTurn || !canAfford(COSTS.settlement)) return;
    const v = gs.verts[vid];
    if (v.building) return;
    const tooClose = v.adjacentVerts.some(av => gs.verts[av].building);
    if (tooClose) return;
    // Must connect to own road
    const myEdges = gs.edges.filter(e => e.road === myIndex).map(e => e.id);
    const connected = v.adjacentEdges.some(ae => myEdges.includes(ae));
    if (!connected) return;

    const newVerts = gs.verts.map((vv, i) => i === vid ? { ...vv, building:"settlement", owner:myIndex } : vv);
    const newPlayers = gs.players.map((p, i) => {
      if (i !== myIndex) return p;
      const res = Object.fromEntries(Object.entries(p.resources).map(([r,v]) => [r, v-(COSTS.settlement[r]||0)]));
      return { ...p, resources: res, settlements: p.settlements+1, victoryPoints: p.victoryPoints+1 };
    });
    setAction(null);
    await updateGS({ verts: newVerts, players: newPlayers, ...log(`${me.name} built a settlement`) });
  }

  async function buildCityAt(vid) {
    if (!isMyTurn || !canAfford(COSTS.city)) return;
    const v = gs.verts[vid];
    if (v.building !== "settlement" || v.owner !== myIndex) return;
    const newVerts = gs.verts.map((vv, i) => i === vid ? { ...vv, building:"city" } : vv);
    const newPlayers = gs.players.map((p, i) => {
      if (i !== myIndex) return p;
      const res = Object.fromEntries(Object.entries(p.resources).map(([r,v]) => [r, v-(COSTS.city[r]||0)]));
      return { ...p, resources: res, cities: p.cities+1, settlements: p.settlements-1, victoryPoints: p.victoryPoints+1 };
    });
    setAction(null);
    await updateGS({ verts: newVerts, players: newPlayers, ...log(`${me.name} built a city`) });
  }

  // ── Dev Cards ────────────────────────────────────────────────────────────
  async function buyDevCard() {
    if (!isMyTurn || !canAfford(COSTS.devCard) || gs.devDeck.length === 0) return;
    const deck = [...gs.devDeck];
    const card = deck.pop();
    const newPlayers = gs.players.map((p, i) => {
      if (i !== myIndex) return p;
      const res = Object.fromEntries(Object.entries(p.resources).map(([r,v]) => [r, v-(COSTS.devCard[r]||0)]));
      let vp = p.victoryPoints;
      if (card === "victoryPoint") vp += 1;
      return { ...p, resources: res, devCards: [...p.devCards, card], victoryPoints: vp };
    });
    await updateGS({ devDeck: deck, devDeckSize: deck.length, players: newPlayers, ...log(`${me.name} bought a dev card`) });
  }

  async function playKnight() {
    if (!isMyTurn) return;
    const idx = me.devCards.indexOf("knight");
    if (idx < 0) return;
    const newCards = [...me.devCards];
    newCards.splice(idx, 1);
    let newPlayers = gs.players.map((p, i) => {
      if (i !== myIndex) return p;
      const k = p.knights + 1;
      return { ...p, devCards: newCards, knights: k };
    });
    let largestArmyPlayer = gs.largestArmyPlayer;
    const myKnights = newPlayers[myIndex].knights;
    if (myKnights >= 3) {
      if (largestArmyPlayer === null || (largestArmyPlayer !== myIndex && myKnights > newPlayers[largestArmyPlayer].knights)) {
        if (largestArmyPlayer !== null) {
          newPlayers[largestArmyPlayer].hasLargestArmy = false;
          newPlayers[largestArmyPlayer].victoryPoints -= 2;
        }
        newPlayers[myIndex].hasLargestArmy = true;
        newPlayers[myIndex].victoryPoints += 2;
        largestArmyPlayer = myIndex;
      }
    }
    setAction("moveRobber");
    await updateGS({ players: newPlayers, largestArmyPlayer, ...log(`${me.name} played a Knight!`) });
  }

  async function playRoadBuilding() {
    if (!isMyTurn) return;
    const idx = me.devCards.indexOf("roadBuilding");
    if (idx < 0) return;
    const newCards = [...me.devCards]; newCards.splice(idx,1);
    const newPlayers = gs.players.map((p,i) => i===myIndex ? {...p,devCards:newCards} : p);
    setPendingRoad(2); setAction("roadBuilding");
    await updateGS({ players: newPlayers, ...log(`${me.name} played Road Building!`) });
  }

  async function playYearOfPlenty() {
    if (!isMyTurn || yearChoices.length !== 2) return;
    const idx = me.devCards.indexOf("yearOfPlenty");
    if (idx < 0) return;
    const newCards = [...me.devCards]; newCards.splice(idx,1);
    const newPlayers = gs.players.map((p,i) => {
      if (i !== myIndex) return p;
      const res = {...p.resources};
      yearChoices.forEach(r => res[r] = (res[r]||0)+1);
      return {...p, devCards:newCards, resources:res};
    });
    setYearChoices([]); setAction(null);
    await updateGS({ players:newPlayers, ...log(`${me.name} played Year of Plenty`) });
  }

  async function playMonopoly() {
    if (!isMyTurn) return;
    const idx = me.devCards.indexOf("monopoly");
    if (idx < 0) return;
    const newCards = [...me.devCards]; newCards.splice(idx,1);
    let total = 0;
    const newPlayers = gs.players.map((p,i) => {
      if (i===myIndex) return {...p, devCards:newCards};
      const stolen = p.resources[monoRes]||0;
      total += stolen;
      return {...p, resources:{...p.resources,[monoRes]:0}};
    });
    newPlayers[myIndex].resources[monoRes] = (newPlayers[myIndex].resources[monoRes]||0)+total;
    setAction(null);
    await updateGS({ players:newPlayers, ...log(`${me.name} played Monopoly on ${monoRes}`) });
  }

  // ── Trading ───────────────────────────────────────────────────────────────
  function getPortRatio(resource) {
    // Check if player has a port
    const myVerts = gs.verts.filter(v => v.owner === myIndex);
    // Simplified: 4:1 always, 3:1 or 2:1 if on port (we'll handle ports as 3:1 for now)
    return 4; // TODO: port detection from board.ports
  }

  async function tradeWithBank() {
    if (!isMyTurn) return;
    const giving = Object.entries(tradeRes).filter(([,v]) => v>0);
    if (giving.length !== 1) return;
    const [giveRes, giveAmt] = giving[0];
    const ratio = getPortRatio(giveRes);
    if (giveAmt < ratio || giveAmt % ratio !== 0) return;
    const gets = (giveAmt / ratio);
    const newPlayers = gs.players.map((p,i) => {
      if (i!==myIndex) return p;
      const res = {...p.resources};
      res[giveRes] -= giveAmt;
      res[tradeGet] = (res[tradeGet]||0) + gets;
      return {...p, resources:res};
    });
    setTradeRes({wood:0,brick:0,sheep:0,wheat:0,ore:0});
    await updateGS({ players:newPlayers, ...log(`${me.name} traded ${giveAmt} ${giveRes} for ${gets} ${tradeGet}`) });
  }

  // ── Discard ───────────────────────────────────────────────────────────────
  async function discard() {
    const total = Object.values(discardAmount).reduce((a,b)=>a+b,0);
    const myTotal = Object.values(me.resources).reduce((a,b)=>a+b,0);
    const needed = Math.floor(myTotal/2);
    if (total !== needed) return;
    const newPlayers = gs.players.map((p,i) => {
      if (i!==myIndex) return p;
      const res = {...p.resources};
      Object.entries(discardAmount).forEach(([r,v]) => res[r]-=v);
      return {...p, resources:res};
    });
    const newMustDiscard = gs.mustDiscard.filter(i => i!==myIndex);
    setDiscardAmount({wood:0,brick:0,sheep:0,wheat:0,ore:0});
    let patch = { players:newPlayers, mustDiscard:newMustDiscard, ...log(`${me.name} discarded ${needed} cards`) };
    if (newMustDiscard.length===0) patch = {...patch, ...{} };
    await updateGS(patch);
  }

  // ── End Turn ──────────────────────────────────────────────────────────────
  async function endTurn() {
    if (!isMyTurn || gs.diceRoll===null) return;
    // Check for winner
    const winner = gs.players.findIndex(p => p.victoryPoints >= 10);
    const total = gs.players.length;
    const next = (gs.currentPlayer+1) % total;

    // 5-6 player special building phase
    let buildingPhase = false;
    if (total >= 5 && gs.diceRoll !== null) buildingPhase = true;

    await updateGS({
      currentPlayer: next,
      diceRoll: null,
      robberMoved: false,
      tradeOffer: null,
      buildingPhase,
      winner: winner >= 0 ? winner : null,
      status: winner >= 0 ? "ended" : "playing",
      ...log(`${me.name} ended their turn`)
    });
    setAction(null);
  }

  // ── Tile Swap (setup only) ────────────────────────────────────────────────
  async function handleSwapClick(tid) {
    if (!gs.swapMode && gs.phase!=="setup" && gs.phase!=="main") return;
    if (!swapFirst) {
      setSwapFirst(tid);
    } else {
      if (swapFirst === tid) { setSwapFirst(null); return; }
      // Swap the two tiles
      const t1 = gs.board.tiles.find(t=>t.id===swapFirst);
      const t2 = gs.board.tiles.find(t=>t.id===tid);
      const newTiles = gs.board.tiles.map(t => {
        if (t.id===swapFirst) return {...t, resource:t2.resource, number:t2.number, hasRobber:t2.hasRobber};
        if (t.id===tid) return {...t, resource:t1.resource, number:t1.number, hasRobber:t1.hasRobber};
        return t;
      });
      let newRobberTile = gs.board.robberTile;
      if (gs.board.robberTile===swapFirst) newRobberTile=tid;
      else if (gs.board.robberTile===tid) newRobberTile=swapFirst;
      setSwapFirst(null);
      await updateGS({ board:{...gs.board, tiles:newTiles}, robberTile:newRobberTile, ...log("Tiles swapped") });
    }
  }

  async function toggleSwapMode() {
    await updateGS({ swapMode: !gs.swapMode });
    setSwapFirst(null);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const mustDiscardNow = gs.mustDiscard?.includes(myIndex);
  const isRobberPhase = gs.diceRoll && gs.diceRoll[0]+gs.diceRoll[1]===7 && !gs.robberMoved && (gs.mustDiscard||[]).length===0;

  return (
    <div style={styles.gameRoot}>
      {/* Winner Banner */}
      {gs.status === "ended" && (
        <div style={styles.winnerBanner}>
          🏆 {gs.players[gs.winner]?.name} WINS with {gs.players[gs.winner]?.victoryPoints} VP!
        </div>
      )}

      {/* Top bar */}
      <div style={styles.topBar}>
        <span style={{color:"#f39c12",fontWeight:900,fontSize:18}}>🏝️ CATAN</span>
        <span style={{color:"#aaa",fontSize:12}}>Room: <b style={{color:"#fff"}}>{roomId}</b></span>
        {gs.swapMode && <span style={{color:"#e74c3c",fontSize:12,fontWeight:700}}>🔄 SWAP MODE ON</span>}
        {/* Swap mode toggle - only in setup or for host */}
        {(myIndex===0) && (
          <button style={{...styles.smBtn, background:gs.swapMode?"#e74c3c":"#555"}} onClick={toggleSwapMode}>
            {gs.swapMode?"Stop Swapping":"Swap Tiles"}
          </button>
        )}
        <span style={{color:"#aaa",fontSize:12}}>You: <b style={{color:me?.color}}>{me?.name}</b></span>
      </div>

      <div style={styles.gameLayout}>
        {/* Board */}
        <div style={styles.boardWrap}>
          {swapFirst !== null && <div style={{color:"#f39c12",textAlign:"center",fontSize:13,marginBottom:4}}>Now click the second tile to swap</div>}
          <svg width={svgW} height={svgH} style={{display:"block",margin:"0 auto"}}>
            {/* Tiles */}
            {gs.board.tiles.map(tile => {
              const {x,y} = hexCenter(tile, layout);
              const corners = hexCorners(x, y, HEX_SIZE-1);
              const pts = corners.map(c=>`${c.x},${c.y}`).join(" ");
              const isRobber = tile.id === gs.board.robberTile;
              const isSwapSelected = swapFirst === tile.id;
              const isSwapTarget = gs.swapMode && action !== "moveRobber";
              return (
                <g key={tile.id} onClick={() => {
                  if (gs.swapMode) handleSwapClick(tile.id);
                  else if (action==="moveRobber") handleRobberTileClick(tile.id);
                }} style={{cursor: (gs.swapMode||(action==="moveRobber"))?"pointer":"default"}}>
                  <polygon points={pts} fill={RESOURCE_COLORS[tile.resource]||"#ccc"}
                    stroke={isSwapSelected?"#fff":isRobber&&!gs.swapMode?"#e74c3c":"#1a1a2e"} strokeWidth={isSwapSelected?3:2}
                    opacity={action==="moveRobber"&&tile.id===gs.board.robberTile?0.4:1}
                  />
                  <text x={x} y={y-8} textAnchor="middle" fontSize={18} style={{pointerEvents:"none"}}>{RESOURCE_EMOJI[tile.resource]}</text>
                  {tile.number && (
                    <g>
                      <circle cx={x} cy={y+10} r={14} fill={tile.number===6||tile.number===8?"#fff":"#ffffffcc"}/>
                      <text x={x} y={y+15} textAnchor="middle" fontSize={13} fontWeight={tile.number===6||tile.number===8?"900":"600"}
                        fill={tile.number===6||tile.number===8?"#c0392b":"#1a1a2e"} style={{pointerEvents:"none"}}>{tile.number}</text>
                    </g>
                  )}
                  {isRobber && <text x={x} y={y+30} textAnchor="middle" fontSize={16} style={{pointerEvents:"none"}}>🏴‍☠️</text>}
                </g>
              );
            })}

            {/* Edges / Roads */}
            {gs.edges.map(e => {
              const v1 = gs.verts[e.v1], v2 = gs.verts[e.v2];
              const mx=(v1.x+v2.x)/2, my=(v1.y+v2.y)/2;
              
              // NEW FIX: Ensures roads highlight correctly during Setup phase
              const touchesMyVertex = (v1.owner === myIndex || v2.owner === myIndex);
              const isSetupRoad = (gs.phase === "roadSetup" && isMyTurn && e.road === null && touchesMyVertex);
              const isNormalRoad = (isMyTurn && (action === "buildRoad" || action === "roadBuilding") && e.road === null);
              const isClickable = isSetupRoad || isNormalRoad;

              return (
                <g key={e.id} onClick={() => {
                  if (!isClickable) return;
                  if (gs.phase === "roadSetup") handleSetupEdgeClick(e.id);
                  else buildRoadAt(e.id);
                }} style={{cursor: isClickable ? "pointer" : "default"}}>
                  <line x1={v1.x} y1={v1.y} x2={v2.x} y2={v2.y}
                    stroke={e.road !== null ? gs.players[e.road]?.color : (isClickable ? "#ffffffaa" : "transparent")}
                    strokeWidth={e.road !== null ? 6 : (isClickable ? 10 : 8)} strokeLinecap="round"/>
                  {isClickable && <circle cx={mx} cy={my} r={8} fill="#ffffffaa"/>}
                </g>
              );
            })}

            {/* Vertices / Buildings */}
            {gs.verts.map(v => {
              const isSetupVert = gs.phase==="setup" && isMyTurn && !v.building && !v.adjacentVerts.some(av=>gs.verts[av].building);
              const isBuildS = isMyTurn && action==="buildSettlement" && !v.building && !v.adjacentVerts.some(av=>gs.verts[av].building);
              const isBuildC = isMyTurn && action==="buildCity" && v.building==="settlement" && v.owner===myIndex;
              const isClickable = isSetupVert || isBuildS || isBuildC;
              const ownerColor = v.owner!==null ? gs.players[v.owner]?.color : null;
              return (
                <g key={v.id} onClick={() => {
                  if (gs.phase==="setup") handleSetupVertexClick(v.id);
                  else if (action==="buildSettlement") buildSettlementAt(v.id);
                  else if (action==="buildCity") buildCityAt(v.id);
                }} style={{cursor:isClickable?"pointer":"default"}}>
                  {v.building==="settlement" && <polygon points={`${v.x},${v.y-12} ${v.x+9},${v.y+6} ${v.x-9},${v.y+6}`} fill={ownerColor} stroke="#fff" strokeWidth={1.5}/>}
                  {v.building==="city" && <>
                    <rect x={v.x-10} y={v.y-10} width={20} height={18} fill={ownerColor} stroke="#fff" strokeWidth={1.5} rx={2}/>
                    <polygon points={`${v.x},${v.y-18} ${v.x+7},${v.y-10} ${v.x-7},${v.y-10}`} fill={ownerColor} stroke="#fff" strokeWidth={1}/>
                  </>}
                  {isClickable && <circle cx={v.x} cy={v.y} r={7} fill="#ffffff66" stroke="#fff" strokeWidth={1.5}/>}
                </g>
              );
            })}
          </svg>
        </div>

        {/* Right Panel */}
        <div style={styles.panel}>
          {/* Players */}
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Players</h3>
            {gs.players.map((p,i) => (
              <div key={i} style={{...styles.playerRow, borderLeft:`3px solid ${p.color}`, opacity:gs.currentPlayer===i?1:0.7}}>
                <div>
                  <span style={{color:p.color,fontWeight:700}}>{p.name}</span>
                  {i===myIndex&&<span style={{color:"#2ecc71",fontSize:10,marginLeft:4}}>(you)</span>}
                  {gs.currentPlayer===i&&<span style={{color:"#f39c12",fontSize:10,marginLeft:4}}>▶ turn</span>}
                  {p.hasLongestRoad&&<span title="Longest Road" style={{marginLeft:4}}>🛤️</span>}
                  {p.hasLargestArmy&&<span title="Largest Army" style={{marginLeft:4}}>⚔️</span>}
                </div>
                <div style={{color:"#f39c12",fontWeight:700,fontSize:14}}>{p.victoryPoints} VP</div>
                <div style={{color:"#aaa",fontSize:11}}>
                  {Object.entries(p.resources).map(([r,v])=>`${RESOURCE_EMOJI[r]}×${v}`).join(" ")}
                </div>
                <div style={{color:"#aaa",fontSize:11}}>
                  🏠{p.settlements} 🏙️{p.cities} 🛤️{p.roads} ⚔️{p.knights} 🃏{p.devCards?.length}
                </div>
              </div>
            ))}
          </div>

          {/* My Turn Actions */}
          {isMyTurn && gs.phase==="main" && !mustDiscardNow && (
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>
                {gs.diceRoll ? `Rolled: ${gs.diceRoll[0]} + ${gs.diceRoll[1]} = ${gs.diceRoll[0]+gs.diceRoll[1]}` : "Your Turn"}
              </h3>

              {!gs.diceRoll && (
                <button style={styles.btn} onClick={rollDice}>🎲 Roll Dice</button>
              )}

              {gs.diceRoll && !isRobberPhase && (
                <>
                  <div style={styles.actionGrid}>
                    <button style={{...styles.smBtn, opacity:canAfford(COSTS.road)?1:0.4}}
                      onClick={() => setAction(action==="buildRoad"?null:"buildRoad")}>
                      {action==="buildRoad"?"Cancel":"🛤️ Road"} ({COSTS.road.wood}🌲{COSTS.road.brick}🧱)
                    </button>
                    <button style={{...styles.smBtn, opacity:canAfford(COSTS.settlement)?1:0.4}}
                      onClick={() => setAction(action==="buildSettlement"?null:"buildSettlement")}>
                      {action==="buildSettlement"?"Cancel":"🏠 Settlement"}
                    </button>
                    <button style={{...styles.smBtn, opacity:canAfford(COSTS.city)?1:0.4}}
                      onClick={() => setAction(action==="buildCity"?null:"buildCity")}>
                      {action==="buildCity"?"Cancel":"🏙️ City"}
                    </button>
                    <button style={{...styles.smBtn, opacity:canAfford(COSTS.devCard)&&gs.devDeckSize>0?1:0.4}}
                      onClick={buyDevCard}>🃏 Dev Card</button>
                  </div>

                  {/* Dev cards */}
                  {me.devCards?.length>0 && (
                    <div style={{marginTop:8}}>
                      <p style={{color:"#aaa",fontSize:11,marginBottom:4}}>Your dev cards:</p>
                      {[...new Set(me.devCards)].map(card => card!=="victoryPoint" && (
                        <button key={card} style={{...styles.smBtn,marginBottom:4,background:"#5a3e8f"}}
                          onClick={() => {
                            if (card==="knight") playKnight();
                            else if (card==="roadBuilding") playRoadBuilding();
                            else if (card==="yearOfPlenty") setAction("yearOfPlenty");
                            else if (card==="monopoly") setAction("monopoly");
                          }}>
                          {card==="knight"?"⚔️ Knight":card==="roadBuilding"?"🛤️ Road Building":card==="yearOfPlenty"?"🌟 Year of Plenty":"🎭 Monopoly"}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Year of Plenty */}
                  {action==="yearOfPlenty" && (
                    <div style={{marginTop:8}}>
                      <p style={{color:"#aaa",fontSize:11}}>Choose 2 resources:</p>
                      <div style={styles.actionGrid}>
                        {Object.keys(RESOURCE_EMOJI).filter(r=>r!=="desert").map(r=>(
                          <button key={r} style={{...styles.smBtn,background:yearChoices.includes(r)?"#2ecc71":"#333"}}
                            onClick={() => {
                              if (yearChoices.includes(r)) setYearChoices(yearChoices.filter(x=>x!==r));
                              else if (yearChoices.length<2) setYearChoices([...yearChoices,r]);
                            }}>{RESOURCE_EMOJI[r]} {r}</button>
                        ))}
                      </div>
                      {yearChoices.length===2&&<button style={{...styles.btn,marginTop:4}} onClick={playYearOfPlenty}>Confirm</button>}
                    </div>
                  )}

                  {/* Monopoly */}
                  {action==="monopoly" && (
                    <div style={{marginTop:8}}>
                      <p style={{color:"#aaa",fontSize:11}}>Choose resource:</p>
                      <select style={styles.select} value={monoRes} onChange={e=>setMonoRes(e.target.value)}>
                        {Object.keys(RESOURCE_EMOJI).filter(r=>r!=="desert").map(r=>(
                          <option key={r} value={r}>{RESOURCE_EMOJI[r]} {r}</option>
                        ))}
                      </select>
                      <button style={{...styles.btn,marginTop:4}} onClick={playMonopoly}>Play Monopoly</button>
                    </div>
                  )}

                  {/* Trade */}
                  <div style={{marginTop:8,borderTop:"1px solid #333",paddingTop:8}}>
                    <p style={{color:"#aaa",fontSize:11,margin:"0 0 4px"}}>Bank Trade (4:1)</p>
                    <div style={styles.actionGrid}>
                      {Object.keys(RESOURCE_EMOJI).filter(r=>r!=="desert").map(r=>(
                        <div key={r} style={{display:"flex",alignItems:"center",gap:4}}>
                          <span style={{fontSize:12}}>{RESOURCE_EMOJI[r]}</span>
                          <input type="number" min={0} max={me.resources[r]||0} value={tradeRes[r]}
                            onChange={e => setTradeRes({...tradeRes,[r]:+e.target.value})}
                            style={{width:36,background:"#222",color:"#fff",border:"1px solid #444",borderRadius:4,padding:"2px 4px",fontSize:11}}/>
                        </div>
                      ))}
                    </div>
                    <div style={{display:"flex",gap:8,marginTop:4,alignItems:"center"}}>
                      <span style={{color:"#aaa",fontSize:11}}>Get:</span>
                      <select style={{...styles.select,flex:1}} value={tradeGet} onChange={e=>setTradeGet(e.target.value)}>
                        {Object.keys(RESOURCE_EMOJI).filter(r=>r!=="desert").map(r=>(
                          <option key={r} value={r}>{RESOURCE_EMOJI[r]} {r}</option>
                        ))}
                      </select>
                      <button style={styles.smBtn} onClick={tradeWithBank}>Trade</button>
                    </div>
                  </div>

                  <button style={{...styles.btn,marginTop:8,background:"#27ae60"}} onClick={endTurn}>End Turn ▶</button>
                </>
              )}

              {/* Robber */}
              {isRobberPhase && action!=="moveRobber" && (
                <button style={{...styles.btn,background:"#e74c3c"}} onClick={() => setAction("moveRobber")}>Move Robber</button>
              )}
              {action==="moveRobber" && <p style={{color:"#e74c3c",fontSize:12}}>Click a tile to place the robber</p>}
              {action==="stealFrom" && (
                <div>
                  <p style={{color:"#f39c12",fontSize:12}}>Steal from:</p>
                  {stealTargets.map(i => (
                    <button key={i} style={{...styles.smBtn,marginRight:4,borderLeft:`3px solid ${gs.players[i].color}`}}
                      onClick={() => stealFrom(i)}>{gs.players[i].name}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Setup instructions */}
          {gs.phase==="setup" && isMyTurn && (
            <div style={styles.card}>
              <p style={{color:"#f39c12",fontSize:13}}>
                {gs.setupRound===1?"Round 1":"Round 2"}: Place a settlement on the board
              </p>
            </div>
          )}
          {gs.phase==="roadSetup" && isMyTurn && (
            <div style={styles.card}>
              <p style={{color:"#f39c12",fontSize:13}}>Place a road next to your settlement</p>
            </div>
          )}
          {!isMyTurn && gs.phase==="main" && (
            <div style={styles.card}>
              <p style={{color:"#aaa",fontSize:13}}>Waiting for {gs.players[gs.currentPlayer]?.name}…</p>
            </div>
          )}

          {/* Discard */}
          {mustDiscardNow && (
            <div style={styles.card}>
              <h3 style={{...styles.cardTitle,color:"#e74c3c"}}>Discard Cards!</h3>
              <p style={{color:"#aaa",fontSize:11}}>You must discard {Math.floor(Object.values(me.resources).reduce((a,b)=>a+b,0)/2)} cards</p>
              {Object.keys(RESOURCE_EMOJI).filter(r=>r!=="desert").map(r=>(
                <div key={r} style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                  <span>{RESOURCE_EMOJI[r]} {r}: {me.resources[r]||0}</span>
                  <input type="number" min={0} max={me.resources[r]||0} value={discardAmount[r]}
                    onChange={e => setDiscardAmount({...discardAmount,[r]:+e.target.value})}
                    style={{width:40,background:"#222",color:"#fff",border:"1px solid #444",borderRadius:4,padding:"2px 4px"}}/>
                </div>
              ))}
              <button style={{...styles.btn,background:"#e74c3c"}} onClick={discard}>Discard</button>
            </div>
          )}

          {/* Log */}
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Game Log</h3>
            <div style={{maxHeight:150,overflowY:"auto"}}>
              {[...(gs.log||[])].reverse().map((l,i) => (
                <p key={i} style={{color:"#aaa",fontSize:11,margin:"2px 0"}}>{l}</p>
              ))}
            </div>
          </div>

          {/* Legend */}
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Resources</h3>
            {Object.entries(RESOURCE_EMOJI).filter(([r])=>r!=="desert").map(([r,e]) => (
              <span key={r} style={{fontSize:11,color:"#aaa",marginRight:8}}>{e} {r}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  lobby: { minHeight:"100vh", background:"linear-gradient(135deg,#0f2027,#203a43,#2c5364)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Segoe UI',sans-serif" },
  lobbyCard: { background:"#1a2535", borderRadius:16, padding:32, width:360, boxShadow:"0 8px 40px #0008" },
  title: { color:"#f39c12", fontWeight:900, fontSize:28, textAlign:"center", margin:"0 0 4px" },
  subtitle: { color:"#aaa", fontSize:13, textAlign:"center", margin:"0 0 20px" },
  input: { width:"100%", padding:"10px 14px", borderRadius:8, border:"1px solid #334", background:"#111d2b", color:"#fff", fontSize:14, marginBottom:10, boxSizing:"border-box" },
  select: { width:"100%", padding:"8px 12px", borderRadius:8, border:"1px solid #334", background:"#111d2b", color:"#fff", fontSize:13, marginBottom:10, boxSizing:"border-box" },
  btn: { width:"100%", padding:"11px 0", borderRadius:8, border:"none", background:"#f39c12", color:"#1a1a1a", fontWeight:800, fontSize:14, cursor:"pointer", marginBottom:6 },
  smBtn: { padding:"6px 12px", borderRadius:6, border:"none", background:"#2c3e50", color:"#fff", fontSize:12, cursor:"pointer", fontWeight:600 },
  section: { marginBottom:8 },
  sectionTitle: { color:"#fff", fontSize:14, fontWeight:700, margin:"12px 0 6px" },
  label: { color:"#aaa", fontSize:12, display:"block", marginBottom:4 },
  divider: { textAlign:"center", color:"#aaa", fontSize:12, margin:"12px 0", borderTop:"1px solid #334", paddingTop:12 },
  error: { color:"#e74c3c", fontSize:12, textAlign:"center", marginTop:8 },
  playerRow: { background:"#111d2b", borderRadius:8, padding:"8px 12px", marginBottom:6, paddingLeft:12 },
  center: { display:"flex", alignItems:"center", justifyContent:"center", minHeight:"100vh", background:"#0f1923" },
  gameRoot: { minHeight:"100vh", background:"#0f1923", fontFamily:"'Segoe UI',sans-serif", display:"flex", flexDirection:"column" },
  topBar: { background:"#111d2b", padding:"8px 16px", display:"flex", alignItems:"center", gap:16, borderBottom:"1px solid #222", flexWrap:"wrap" },
  gameLayout: { display:"flex", flex:1, gap:0, overflow:"auto" },
  boardWrap: { flex:1, overflowX:"auto", overflowY:"auto", padding:16, display:"flex", flexDirection:"column", alignItems:"center" },
  panel: { width:280, background:"#111d2b", overflowY:"auto", padding:12, borderLeft:"1px solid #222" },
  card: { background:"#1a2535", borderRadius:10, padding:12, marginBottom:10 },
  cardTitle: { color:"#f39c12", fontSize:13, fontWeight:700, margin:"0 0 8px" },
  winnerBanner: { background:"#f39c12", color:"#1a1a1a", textAlign:"center", padding:"12px", fontWeight:900, fontSize:18, letterSpacing:2 },
  actionGrid: { display:"flex", flexWrap:"wrap", gap:6 },
};
