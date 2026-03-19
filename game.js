/**
 * Memory (Concentration) — TypeScript IL game spec using @engine SDK.
 *
 * 4x4 grid of paired cards (8 pairs). Players flip two cards per turn
 * to find matching pairs.
 *   - Player 1 / AI 1: Human (playerVsAi) or strategic AI with imperfect memory
 *   - Player 2 / AI 2: Random AI with no memory
 * Uses @engine/cards for deck, shuffle, and card rendering.
 */

import { defineGame } from '@engine/core';
import { pickRandomMove, pickBestMove } from '@engine/ai';
import { consumeAction } from '@engine/input';
import {
  clearCanvas, drawBorder, drawRoundedRect,
  drawTextCell, drawLabel, drawHUD, drawGameOver,
} from '@engine/render';
import { drawTouchOverlay } from '@engine/touch';
import { createDeck, shuffle, drawCardFace, drawCardBack } from '@engine/cards';

// ── Constants ───────────────────────────────────────────────────────

const COLS = 4;
const ROWS = 4;
const TOTAL_PAIRS = (COLS * ROWS) / 2;
const CARD_W = 70;
const CARD_H = 98;
const CARD_GAP = 12;
const MARGIN = 20;
const BOARD_W = COLS * (CARD_W + CARD_GAP) - CARD_GAP;
const BOARD_H = ROWS * (CARD_H + CARD_GAP) - CARD_GAP;
const CANVAS_W = BOARD_W + MARGIN * 2 + 170;
const CANVAS_H = BOARD_H + MARGIN * 2 + 50;

const FLIP_DELAY = 800;   // Time to show flipped pair before hiding
const AI_DELAY = 600;     // AI thinking delay

// ── Game Definition ─────────────────────────────────────────────────

const game = defineGame({
  display: {
    type: 'custom',
    width: COLS,
    height: ROWS,
    cellSize: CARD_W,
    canvasWidth: CANVAS_W,
    canvasHeight: CANVAS_H,
    offsetX: MARGIN,
    offsetY: MARGIN + 30,
    background: '#1a2a1a',
  },
  input: {
    up:      { keys: ['ArrowUp', 'w'] },
    down:    { keys: ['ArrowDown', 's'] },
    left:    { keys: ['ArrowLeft', 'a'] },
    right:   { keys: ['ArrowRight', 'd'] },
    select:  { keys: [' ', 'Enter'] },
    restart: { keys: ['r', 'R'] },
  },
});

// ── Resources ───────────────────────────────────────────────────────

game.resource('state', {
  score: 0,
  gameOver: false,
  currentTurn: 'p1',   // 'p1' | 'p2'
  phase: 'pick1',      // 'pick1' | 'pick2' | 'reveal' | 'matched'
  p1Matches: 0,
  p2Matches: 0,
  p1Moves: 0,
  p2Moves: 0,
  totalMatched: 0,
  message: "Player 1's turn",
  revealTimer: 0,
});

game.resource('board', {
  cards: [],       // flat array of card objects [{rank, suit, pairId, faceUp, matched}]
  flipped: [],     // indices of currently flipped cards (0-1 or 0-2)
  initialized: false,
});

game.resource('_cursor', { r: 0, c: 0 });
game.resource('_aiTimer', { elapsed: 0 });
game.resource('_aiMemory', {
  seen: {},       // pairId -> [index, ...] cards the AI has "seen"
  memoryRate: 0.7, // probability of remembering a card
});

// ── Board Init ──────────────────────────────────────────────────────

game.system('init', function initSystem(world, _dt) {
  const board = world.getResource('board');
  if (board.initialized) return;
  board.initialized = true;

  // Create 8 pairs using a subset of a standard deck
  const deck = createDeck();
  const subset = deck.slice(0, TOTAL_PAIRS);
  const pairs = [];
  for (let i = 0; i < subset.length; i++) {
    const card = subset[i];
    pairs.push({
      rank: card.rank, suit: card.suit, pairId: i,
      faceUp: false, matched: false, index: i * 2,
    });
    pairs.push({
      rank: card.rank, suit: card.suit, pairId: i,
      faceUp: false, matched: false, index: i * 2 + 1,
    });
  }

  board.cards = shuffle(pairs);
  // Reassign indices after shuffle
  for (let i = 0; i < board.cards.length; i++) {
    board.cards[i].index = i;
  }
  board.flipped = [];
});

// ── Helper Functions ────────────────────────────────────────────────

function cardIndex(r, c) {
  return r * COLS + c;
}

function cardPos(index) {
  return { r: Math.floor(index / COLS), c: index % COLS };
}

function getUnflippedCards(board) {
  const available = [];
  for (let i = 0; i < board.cards.length; i++) {
    if (!board.cards[i].matched && !board.cards[i].faceUp) {
      available.push(i);
    }
  }
  return available;
}

function flipCard(board, index) {
  const card = board.cards[index];
  if (card.matched || card.faceUp) return false;
  card.faceUp = true;
  board.flipped.push(index);
  return true;
}

function checkMatch(board, state) {
  if (board.flipped.length !== 2) return;

  const c1 = board.cards[board.flipped[0]];
  const c2 = board.cards[board.flipped[1]];

  if (c1.pairId === c2.pairId) {
    // Match found
    c1.matched = true;
    c2.matched = true;
    state.totalMatched++;
    if (state.currentTurn === 'p1') {
      state.p1Matches++;
      state.score += 10;
    } else {
      state.p2Matches++;
    }
    board.flipped = [];
    state.phase = 'pick1';

    if (state.totalMatched >= TOTAL_PAIRS) {
      state.gameOver = true;
      if (state.p1Matches > state.p2Matches) {
        state.message = 'Player 1 wins!';
        state.score += 50;
      } else if (state.p2Matches > state.p1Matches) {
        state.message = 'Player 2 wins!';
      } else {
        state.message = "It's a tie!";
      }
    }
    return;
  }

  // No match — start reveal timer
  state.phase = 'reveal';
  state.revealTimer = 0;
}

function hideFlipped(board, state) {
  for (const idx of board.flipped) {
    board.cards[idx].faceUp = false;
  }
  board.flipped = [];
  state.phase = 'pick1';
  // Switch turns
  state.currentTurn = state.currentTurn === 'p1' ? 'p2' : 'p1';
  const gm_label = state.currentTurn === 'p1' ? 'Player 1' : 'Player 2';
  state.message = `${gm_label}'s turn`;
}

// ── Reveal Timer System ─────────────────────────────────────────────

game.system('revealTimer', function revealTimerSystem(world, dt) {
  const state = world.getResource('state');
  if (state.phase !== 'reveal') return;

  state.revealTimer += dt;
  if (state.revealTimer >= FLIP_DELAY) {
    const board = world.getResource('board');
    hideFlipped(board, state);
  }
});

// ── Player Input System ─────────────────────────────────────────────

game.system('playerInput', function playerInputSystem(world, _dt) {
  const gm = world.getResource('gameMode');
  if (!gm || gm.mode !== 'playerVsAi') return;

  const state = world.getResource('state');
  if (state.gameOver) return;
  if (state.currentTurn !== 'p1') return;
  if (state.phase === 'reveal') return;

  const input = world.getResource('input');
  const cursor = world.getResource('_cursor');
  const board = world.getResource('board');

  if (consumeAction(input, 'up') && cursor.r > 0) cursor.r--;
  if (consumeAction(input, 'down') && cursor.r < ROWS - 1) cursor.r++;
  if (consumeAction(input, 'left') && cursor.c > 0) cursor.c--;
  if (consumeAction(input, 'right') && cursor.c < COLS - 1) cursor.c++;

  if (consumeAction(input, 'select')) {
    const idx = cardIndex(cursor.r, cursor.c);
    if (!flipCard(board, idx)) return;

    if (state.phase === 'pick1') {
      state.phase = 'pick2';
      state.p1Moves++;
    } else if (state.phase === 'pick2') {
      checkMatch(board, state);
    }
  }
});

// ── AI System ───────────────────────────────────────────────────────

game.system('ai', function aiSystem(world, dt) {
  const state = world.getResource('state');
  if (state.gameOver) return;
  if (state.phase === 'reveal') return;

  const gm = world.getResource('gameMode');
  const isPlayerMode = gm && gm.mode === 'playerVsAi';

  // In playerVsAi, AI only plays p2
  if (isPlayerMode && state.currentTurn === 'p1') return;

  const timer = world.getResource('_aiTimer');
  timer.elapsed += dt;
  if (timer.elapsed < AI_DELAY) return;
  timer.elapsed = 0;

  const board = world.getResource('board');
  const memory = world.getResource('_aiMemory');
  const available = getUnflippedCards(board);

  if (available.length === 0) return;

  if (state.currentTurn === 'p1') {
    // Strategic AI with imperfect memory
    aiPickWithMemory(board, state, memory, available);
  } else {
    // Simpler AI — pick randomly but use memory sometimes
    aiPickSimple(board, state, memory, available);
  }
});

function recordSeen(memory, board, index) {
  if (Math.random() < memory.memoryRate) {
    const card = board.cards[index];
    if (!memory.seen[card.pairId]) memory.seen[card.pairId] = [];
    if (!memory.seen[card.pairId].includes(index)) {
      memory.seen[card.pairId].push(index);
    }
  }
}

function aiPickWithMemory(board, state, memory, available) {
  if (state.phase === 'pick1') {
    // Check memory for known pairs
    for (const pairId in memory.seen) {
      const indices = memory.seen[pairId].filter(i => !board.cards[i].matched && !board.cards[i].faceUp);
      if (indices.length >= 2) {
        flipCard(board, indices[0]);
        recordSeen(memory, board, indices[0]);
        state.phase = 'pick2';
        state.p1Moves++;
        return;
      }
    }
    // Random pick
    const pick = available[Math.floor(Math.random() * available.length)];
    flipCard(board, pick);
    recordSeen(memory, board, pick);
    state.phase = 'pick2';
    state.p1Moves++;
  } else if (state.phase === 'pick2') {
    const firstIdx = board.flipped[0];
    const firstCard = board.cards[firstIdx];

    // Check if we know where the match is
    const known = (memory.seen[firstCard.pairId] || []).filter(
      i => i !== firstIdx && !board.cards[i].matched && !board.cards[i].faceUp
    );
    if (known.length > 0) {
      flipCard(board, known[0]);
      recordSeen(memory, board, known[0]);
    } else {
      const remaining = available.filter(i => i !== firstIdx);
      if (remaining.length > 0) {
        const pick = remaining[Math.floor(Math.random() * remaining.length)];
        flipCard(board, pick);
        recordSeen(memory, board, pick);
      }
    }
    checkMatch(board, state);
  }
}

function aiPickSimple(board, state, memory, available) {
  if (state.phase === 'pick1') {
    const pick = available[Math.floor(Math.random() * available.length)];
    flipCard(board, pick);
    recordSeen(memory, board, pick);
    state.phase = 'pick2';
    state.p2Moves++;
  } else if (state.phase === 'pick2') {
    const firstIdx = board.flipped[0];
    const remaining = available.filter(i => i !== firstIdx);
    if (remaining.length > 0) {
      const pick = remaining[Math.floor(Math.random() * remaining.length)];
      flipCard(board, pick);
      recordSeen(memory, board, pick);
    }
    checkMatch(board, state);
  }
}

// ── Render System ───────────────────────────────────────────────────

game.system('render', function renderSystem(world, _dt) {
  const renderer = world.getResource('renderer');
  if (!renderer) return;

  const { ctx } = renderer;
  const state = world.getResource('state');
  const board = world.getResource('board');
  const ox = MARGIN;
  const oy = MARGIN + 30;

  clearCanvas(ctx, '#1a2a1a');

  // Title
  drawLabel(ctx, 'MEMORY', ox, oy - 10, { color: '#e0e0e0', fontSize: 18 });

  // Board background
  drawRoundedRect(ctx, ox - 4, oy - 4, BOARD_W + 8, BOARD_H + 8, 8, '#0d1a0d', {
    strokeColor: '#2a4a2a', strokeWidth: 2,
  });

  // Draw cards
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = cardIndex(r, c);
      const card = board.cards[idx];
      if (!card) continue;

      const px = ox + c * (CARD_W + CARD_GAP);
      const py = oy + r * (CARD_H + CARD_GAP);

      if (card.matched) {
        // Matched card — show dimmed
        drawRoundedRect(ctx, px, py, CARD_W, CARD_H, 6, '#1a3a1a', {
          strokeColor: '#2a5a2a', strokeWidth: 1,
        });
        drawCardFace(ctx, px, py, CARD_W, CARD_H, card);
        ctx.fillStyle = 'rgba(0, 40, 0, 0.4)';
        ctx.fillRect(px, py, CARD_W, CARD_H);
      } else if (card.faceUp) {
        // Flipped card
        drawCardFace(ctx, px, py, CARD_W, CARD_H, card);
      } else {
        // Face down
        drawCardBack(ctx, px, py, CARD_W, CARD_H);
      }
    }
  }

  // Draw cursor in player mode
  const gm = world.getResource('gameMode');
  if (gm && gm.mode === 'playerVsAi' && state.currentTurn === 'p1' && !state.gameOver && state.phase !== 'reveal') {
    const cursor = world.getResource('_cursor');
    const px = ox + cursor.c * (CARD_W + CARD_GAP);
    const py = oy + cursor.r * (CARD_H + CARD_GAP);
    ctx.strokeStyle = '#ffd740';
    ctx.lineWidth = 3;
    ctx.strokeRect(px - 2, py - 2, CARD_W + 4, CARD_H + 4);
  }

  // HUD panel
  const hudX = ox + BOARD_W + 20;
  const isPlayerMode = gm && gm.mode === 'playerVsAi';

  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = state.currentTurn === 'p1' ? '#4caf50' : '#42a5f5';
  ctx.fillText(state.message, hudX, oy + 20);

  ctx.font = '12px monospace';
  ctx.fillStyle = '#888';
  ctx.fillText(`Pairs left: ${TOTAL_PAIRS - state.totalMatched}`, hudX, oy + 50);

  // Player 1 stats
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = '#4caf50';
  ctx.fillText(isPlayerMode ? 'You' : 'P1 (Memory AI)', hudX, oy + 85);
  ctx.font = '12px monospace';
  ctx.fillStyle = '#aaa';
  ctx.fillText(`Matches: ${state.p1Matches}`, hudX, oy + 103);
  ctx.fillText(`Moves: ${state.p1Moves}`, hudX, oy + 119);

  // Player 2 stats
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = '#42a5f5';
  ctx.fillText(isPlayerMode ? 'AI' : 'P2 (Random AI)', hudX, oy + 150);
  ctx.font = '12px monospace';
  ctx.fillStyle = '#aaa';
  ctx.fillText(`Matches: ${state.p2Matches}`, hudX, oy + 168);
  ctx.fillText(`Moves: ${state.p2Moves}`, hudX, oy + 184);

  // Scoreboard visual
  const barW = 130;
  const barH = 10;
  const barY = oy + 210;
  ctx.fillStyle = '#333';
  ctx.fillRect(hudX, barY, barW, barH);
  if (state.totalMatched > 0) {
    const p1Pct = state.p1Matches / TOTAL_PAIRS;
    const p2Pct = state.p2Matches / TOTAL_PAIRS;
    ctx.fillStyle = '#4caf50';
    ctx.fillRect(hudX, barY, barW * p1Pct, barH);
    ctx.fillStyle = '#42a5f5';
    ctx.fillRect(hudX + barW * p1Pct, barY, barW * p2Pct, barH);
  }

  drawBorder(ctx, ox - 4, oy - 4, BOARD_W + 8, BOARD_H + 8, '#2a4a2a');

  if (state.gameOver) {
    const title = state.p1Matches > state.p2Matches
      ? (isPlayerMode ? 'YOU WIN!' : 'P1 WINS!')
      : state.p2Matches > state.p1Matches
        ? (isPlayerMode ? 'AI WINS!' : 'P2 WINS!')
        : 'TIE!';
    const titleColor = state.p1Matches >= state.p2Matches ? '#4caf50' : '#42a5f5';

    drawGameOver(ctx, ox - 4, oy - 4, BOARD_W + 8, BOARD_H + 8, {
      title,
      titleColor,
      subtitle: `${state.p1Matches} - ${state.p2Matches} | Press R`,
    });
  }

  drawTouchOverlay(ctx, ctx.canvas.width, ctx.canvas.height);
});

export default game;
