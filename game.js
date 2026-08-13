/* BlockBreak — ブロックブラスト風パズル
 * 8x8 の盤面に 3 つのピースをドラッグで配置し、行・列が埋まると消える。
 * 3 つとも置けなくなったらゲームオーバー。
 */
(() => {
  'use strict';

  const SIZE = 8;
  const STORAGE_KEY = 'blockbreak.best';

  /* ------------------------------------------------------------------ *
   * ピース定義
   * ------------------------------------------------------------------ */

  // 各ピースは「基本形 + 回転で得られる全パターン」で扱う。
  // weight は出現しやすさ（大きいほどよく出る）。
  const BASE_SHAPES = [
    { color: '#5ac8fa', weight: 3,  cells: ['X'] },
    { color: '#4d8cff', weight: 8,  cells: ['XX'] },
    { color: '#4d8cff', weight: 8,  cells: ['XXX'] },
    { color: '#7b61ff', weight: 6,  cells: ['XXXX'] },
    { color: '#a259ff', weight: 3,  cells: ['XXXXX'] },
    { color: '#ffb020', weight: 8,  cells: ['XX', 'XX'] },
    { color: '#ff7a45', weight: 4,  cells: ['XXX', 'XXX'] },
    { color: '#ff4d6d', weight: 2,  cells: ['XXX', 'XXX', 'XXX'] },
    { color: '#2ecc71', weight: 8,  cells: ['X.', 'XX'] },
    { color: '#12b886', weight: 5,  cells: ['X..', 'XXX'] },
    { color: '#00b8a9', weight: 4,  cells: ['X..', 'X..', 'XXX'] },
    { color: '#ff6fb5', weight: 4,  cells: ['XXX', '.X.'] },
    { color: '#f95d6a', weight: 3,  cells: ['.XX', 'XX.'] },
    { color: '#c77dff', weight: 3,  cells: ['XX.', '.XX'] },
  ];

  /** "XX." 形式の文字列配列を [row, col] の座標配列に変換する。 */
  function parseCells(rows) {
    const out = [];
    rows.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch === 'X') out.push([r, c]);
      });
    });
    return out;
  }

  /** 座標配列を時計回りに 90 度回転させ、左上詰めに正規化する。 */
  function rotate(cells) {
    const maxR = Math.max(...cells.map(([r]) => r));
    return normalize(cells.map(([r, c]) => [c, maxR - r]));
  }

  function normalize(cells) {
    const minR = Math.min(...cells.map(([r]) => r));
    const minC = Math.min(...cells.map(([, c]) => c));
    return cells
      .map(([r, c]) => [r - minR, c - minC])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  const key = (cells) => cells.map(([r, c]) => `${r},${c}`).join('|');

  /** 基本形から重複しない回転パターンを展開したピース一覧。 */
  const PIECES = [];
  BASE_SHAPES.forEach((shape) => {
    const seen = new Set();
    const variants = [];
    let cells = normalize(parseCells(shape.cells));
    for (let i = 0; i < 4; i++) {
      const k = key(cells);
      if (!seen.has(k)) {
        seen.add(k);
        variants.push(cells);
      }
      cells = rotate(cells);
    }
    // weight は「基本形の出やすさ」。回転の種類数で割っておかないと、
    // 回転が多い形ほど実際の出現率が高くなってしまう。
    variants.forEach((variant) => {
      PIECES.push({
        cells: variant,
        color: shape.color,
        weight: shape.weight / variants.length,
        rows: Math.max(...variant.map(([r]) => r)) + 1,
        cols: Math.max(...variant.map(([, c]) => c)) + 1,
      });
    });
  });

  const TOTAL_WEIGHT = PIECES.reduce((sum, p) => sum + p.weight, 0);

  function randomPiece() {
    let n = Math.random() * TOTAL_WEIGHT;
    for (const piece of PIECES) {
      n -= piece.weight;
      if (n <= 0) return piece;
    }
    return PIECES[PIECES.length - 1];
  }

  /* ------------------------------------------------------------------ *
   * ゲーム状態
   * ------------------------------------------------------------------ */

  /* localStorage は環境によっては参照した時点で例外を投げる
   * （iframe の sandbox、サイトデータのブロック、Safari のプライベートなど）。
   * ゲーム本体が巻き添えで停止しないよう、必ずこのラッパ経由で読み書きする。 */
  const store = {
    get(name) {
      try {
        return localStorage.getItem(name);
      } catch (_) {
        return null;
      }
    },
    set(name, value) {
      try {
        localStorage.setItem(name, value);
      } catch (_) {
        // 保存できない環境では黙って諦める（プレイは継続できる）。
      }
    },
  };

  const state = {
    grid: [],        // null または色文字列
    tray: [],        // { piece, used } × 3
    score: 0,
    best: 0,
    combo: 0,        // 連続でライン消去した回数
    over: false,
    busy: false,     // ライン消去の演出中は入力を受け付けない
    beatBest: false, // このゲーム中に自己ベストを更新したか
  };

  // キーボード操作の状態（選択中のピースと盤面カーソル）
  const kb = { index: null, row: 0, col: 0 };

  let clearTimer = null;      // 消去演出の後始末を予約したタイマー
  let allClearTimer = null;   // 全消し演出の後始末を予約したタイマー

  const el = {
    board: document.getElementById('board'),
    fx: document.getElementById('fx'),
    tray: document.getElementById('tray'),
    score: document.getElementById('score'),
    best: document.getElementById('best'),
    combo: document.getElementById('combo'),
    hint: document.getElementById('hint'),
    dragLayer: document.getElementById('drag-layer'),
    overlay: document.getElementById('overlay'),
    finalScore: document.getElementById('final-score'),
    finalBest: document.getElementById('final-best'),
    panelTitle: document.getElementById('panel-title'),
    panelSub: document.getElementById('panel-sub'),
    soundBtn: document.getElementById('sound-btn'),
    soundIcon: document.getElementById('sound-icon'),
    status: document.getElementById('status'),
  };

  /** スクリーンリーダー向けに状況を読み上げる。 */
  function announce(text) {
    el.status.textContent = text;
  }

  const cellEls = [];

  function buildBoard() {
    el.board.style.setProperty('--cols', SIZE);
    el.board.innerHTML = '';
    cellEls.length = 0;
    for (let r = 0; r < SIZE; r++) {
      cellEls[r] = [];
      // role="grid" の子は role="row" である必要があるため、行を包む。
      const rowEl = document.createElement('div');
      rowEl.className = 'row';
      rowEl.setAttribute('role', 'row');
      for (let c = 0; c < SIZE; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.id = `cell-${r}-${c}`;
        cell.setAttribute('role', 'gridcell');
        rowEl.appendChild(cell);
        cellEls[r][c] = cell;
      }
      el.board.appendChild(rowEl);
    }
  }

  function emptyGrid() {
    return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  }

  /* ------------------------------------------------------------------ *
   * 配置判定
   * ------------------------------------------------------------------ */

  function canPlaceAt(piece, row, col, grid = state.grid) {
    for (const [dr, dc] of piece.cells) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE || grid[r][c]) return false;
    }
    return true;
  }

  function hasAnyPlacement(piece, grid = state.grid) {
    for (let r = 0; r <= SIZE - piece.rows; r++) {
      for (let c = 0; c <= SIZE - piece.cols; c++) {
        if (canPlaceAt(piece, r, c, grid)) return true;
      }
    }
    return false;
  }

  /** 盤面に置いた結果、揃う行・列を返す（実際には置かない）。 */
  function linesAfterPlacing(piece, row, col) {
    const filled = new Set(piece.cells.map(([dr, dc]) => `${row + dr},${col + dc}`));
    const isFilled = (r, c) => Boolean(state.grid[r][c]) || filled.has(`${r},${c}`);

    const rows = [];
    const cols = [];
    for (let r = 0; r < SIZE; r++) {
      let full = true;
      for (let c = 0; c < SIZE; c++) if (!isFilled(r, c)) { full = false; break; }
      if (full) rows.push(r);
    }
    for (let c = 0; c < SIZE; c++) {
      let full = true;
      for (let r = 0; r < SIZE; r++) if (!isFilled(r, c)) { full = false; break; }
      if (full) cols.push(c);
    }
    return { rows, cols };
  }

  /* ------------------------------------------------------------------ *
   * 描画
   * ------------------------------------------------------------------ */

  function renderBoard() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = cellEls[r][c];
        // 消去アニメーション中のマスは、演出が終わるまで見た目を触らない。
        if (cell.classList.contains('clearing')) continue;
        const color = state.grid[r][c];
        const wasFilled = cell.classList.contains('filled');
        if (color) {
          cell.style.setProperty('--c', color);
          if (!wasFilled) cell.classList.add('filled');
        } else if (wasFilled) {
          cell.classList.remove('filled');
          cell.style.removeProperty('--c');
        }
        cell.setAttribute('aria-label', `${r + 1}行${c + 1}列 ${color ? 'ブロック' : '空'}`);
      }
    }
  }

  function clearPreview() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = cellEls[r][c];
        if (cell.classList.contains('preview') ||
            cell.classList.contains('preview-line') ||
            cell.classList.contains('invalid')) {
          cell.classList.remove('preview', 'preview-line', 'invalid');
          if (!cell.classList.contains('filled')) cell.style.removeProperty('--c');
        }
      }
    }
  }

  function showPreview(piece, row, col) {
    clearPreview();
    if (row === null) return;

    if (!canPlaceAt(piece, row, col)) {
      for (const [dr, dc] of piece.cells) {
        const r = row + dr;
        const c = col + dc;
        if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && !state.grid[r][c]) {
          cellEls[r][c].classList.add('invalid');
        }
      }
      return;
    }

    const { rows, cols } = linesAfterPlacing(piece, row, col);
    const rowSet = new Set(rows);
    const colSet = new Set(cols);

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if ((rowSet.has(r) || colSet.has(c)) && state.grid[r][c]) {
          cellEls[r][c].classList.add('preview-line');
        }
      }
    }
    for (const [dr, dc] of piece.cells) {
      const cell = cellEls[row + dr][col + dc];
      cell.style.setProperty('--c', piece.color);
      cell.classList.add('preview');
    }
  }

  const describePiece = (piece) =>
    `${piece.cells.length}マス たて${piece.rows}×よこ${piece.cols}`;

  /** ピース DOM を生成する（cellSize は 1 マスの px）。 */
  function buildPieceEl(piece, cellSize, className) {
    const wrap = document.createElement('div');
    wrap.className = className;
    wrap.style.gridTemplateColumns = `repeat(${piece.cols}, ${cellSize}px)`;
    wrap.style.setProperty('--pc', `${cellSize}px`);
    wrap.style.setProperty('--c', piece.color);

    const filled = new Set(piece.cells.map(([r, c]) => `${r},${c}`));
    for (let r = 0; r < piece.rows; r++) {
      for (let c = 0; c < piece.cols; c++) {
        const dot = document.createElement('div');
        dot.className = filled.has(`${r},${c}`) ? 'pc' : 'pc empty';
        wrap.appendChild(dot);
      }
    }
    return wrap;
  }

  /** 盤面 1 マスの実寸と原点（gap 込みの間隔）を測る。 */
  function boardMetrics() {
    const first = cellEls[0][0].getBoundingClientRect();
    const second = cellEls[0][1].getBoundingClientRect();
    return { x: first.left, y: first.top, size: first.width, step: second.left - first.left };
  }

  function renderTray() {
    const board = boardMetrics();
    const gap = board.step - board.size;

    el.tray.innerHTML = '';
    const holders = state.tray.map(() => {
      const holder = document.createElement('div');
      holder.className = 'slot';
      el.tray.appendChild(holder);
      return holder;
    });
    // 中身を入れるとスロットの寸法が変わり得るので、先に全部測っておく。
    const boxes = holders.map((holder) => holder.getBoundingClientRect());

    state.tray.forEach((slot, index) => {
      if (slot.used) return;
      const piece = slot.piece;
      const box = boxes[index];
      // 盤面のマスより少し小さく、かつスロットからはみ出さない大きさにする。
      const cellSize = Math.max(10, Math.min(
        board.size * 0.62,
        (box.height - (piece.rows - 1) * gap) / piece.rows,
        (box.width - (piece.cols - 1) * gap) / piece.cols,
      ));
      const pieceEl = buildPieceEl(piece, cellSize, 'piece');
      pieceEl.dataset.index = String(index);
      const placeable = hasAnyPlacement(piece);
      if (!placeable) pieceEl.classList.add('dead');

      // キーボードでも掴めるようにする。
      pieceEl.tabIndex = 0;
      pieceEl.setAttribute('role', 'button');
      pieceEl.setAttribute('aria-label',
        `ピース${index + 1}: ${describePiece(piece)}${placeable ? '' : '、置ける場所なし'}`);
      if (kb.index === index) pieceEl.classList.add('selected');

      holders[index].appendChild(pieceEl);
    });
  }

  function renderScore(animate) {
    el.score.textContent = String(state.score);
    el.best.textContent = String(state.best);
    if (animate) {
      el.score.classList.add('pop');
      setTimeout(() => el.score.classList.remove('pop'), 130);
    }
  }

  function showCombo(text, big) {
    el.combo.textContent = text;
    el.combo.classList.add('show');
    el.combo.classList.toggle('big', Boolean(big));
    clearTimeout(showCombo.timer);
    showCombo.timer = setTimeout(() => el.combo.classList.remove('show'), big ? 1600 : 1100);
  }

  function popScore(points, row, col) {
    const m = boardMetrics();
    const boardRect = el.board.getBoundingClientRect();
    const node = document.createElement('div');
    node.className = 'pop-score';
    node.textContent = `+${points}`;
    node.style.left = `${m.x - boardRect.left + col * m.step + m.size / 2}px`;
    node.style.top = `${m.y - boardRect.top + row * m.step + m.size / 2}px`;
    el.fx.appendChild(node);
    setTimeout(() => node.remove(), 900);
  }

  /* ------------------------------------------------------------------ *
   * サウンド（WebAudio の簡易ビープ）
   * ------------------------------------------------------------------ */

  const sound = {
    on: store.get('blockbreak.sound') !== 'off',
    ctx: null,
    play(freq, duration = 0.12, type = 'triangle', gain = 0.06) {
      if (!this.on) return;
      try {
        this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const osc = this.ctx.createOscillator();
        const amp = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        amp.gain.setValueAtTime(gain, this.ctx.currentTime);
        amp.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
        osc.connect(amp).connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
      } catch (_) { /* サウンド非対応環境では無視 */ }
    },
    toggle() {
      this.on = !this.on;
      store.set('blockbreak.sound', this.on ? 'on' : 'off');
      el.soundIcon.textContent = this.on ? '🔊' : '🔇';
      el.soundBtn.classList.toggle('off', !this.on);
      if (this.on) this.play(660, 0.08);
    },
  };

  /* ------------------------------------------------------------------ *
   * ピース配置とライン消去
   * ------------------------------------------------------------------ */

  /** ドロップされたピースを盤面へ確定させる。
   * index だけでなく piece 自体も受け取り、掴んだときのピースと
   * トレイの中身が食い違っていたら（ドラッグ中にリスタートされた等）配置しない。 */
  function placePiece(index, piece, row, col) {
    const slot = state.tray[index];
    if (state.over || state.busy) return false;
    if (!slot || slot.used || slot.piece !== piece) return false;
    if (!canPlaceAt(piece, row, col)) return false;

    for (const [dr, dc] of piece.cells) {
      state.grid[row + dr][col + dc] = piece.color;
    }
    slot.used = true;

    const { rows, cols } = linesAfterPlacing(piece, row, col);
    // linesAfterPlacing は配置前提の判定なので、配置済みの現在の盤面でも同じ結果になる。

    addScore(piece.cells.length, false);
    sound.play(320 + piece.cells.length * 20, 0.09, 'square', 0.045);

    renderBoard();

    const lineCount = rows.length + cols.length;
    if (lineCount > 0) {
      clearLines(rows, cols, lineCount, row, col);
      announce(`${row + 1}行${col + 1}列に配置。${lineCount}ライン消去。スコア ${state.score} 点。`);
    } else {
      state.combo = 0;
      finishTurn();
      announce(`${row + 1}行${col + 1}列に配置。スコア ${state.score} 点。`);
    }
    return true;
  }

  function clearLines(rows, cols, lineCount, anchorRow, anchorCol) {
    state.combo += 1;
    state.busy = true;

    const targets = new Set();
    rows.forEach((r) => { for (let c = 0; c < SIZE; c++) targets.add(`${r},${c}`); });
    cols.forEach((c) => { for (let r = 0; r < SIZE; r++) targets.add(`${r},${c}`); });

    // 盤面の状態はここで即座に更新し、演出だけを後回しにする。
    // 消えたはずのラインが state.grid に残っていると、次の一手が
    // 同じラインを二重に消したものと判定してしまうため。
    targets.forEach((k) => {
      const [r, c] = k.split(',').map(Number);
      state.grid[r][c] = null;
      cellEls[r][c].classList.add('clearing');
    });

    // 1 ライン 100 点、同時消しでボーナス、コンボで倍率。
    const base = lineCount * 100 + Math.max(0, lineCount - 1) * 50;
    const points = base * state.combo;
    addScore(points, true);

    popScore(points, anchorRow, anchorCol);
    if (lineCount >= 2 || state.combo >= 2) {
      const parts = [];
      if (state.combo >= 2) parts.push(`COMBO ×${state.combo}`);
      if (lineCount >= 2) parts.push(`${lineCount} LINES!`);
      showCombo(parts.join('  '));
      el.board.classList.add('shake');
      setTimeout(() => el.board.classList.remove('shake'), 300);
    }

    for (let i = 0; i < lineCount; i++) {
      sound.play(520 + i * 110, 0.16, 'triangle', 0.05);
    }

    // 盤面が空になったか（全消し）は、ここで確定している。
    // 演出はマスが消え終わってから出したいので、後片付けと一緒に走らせる。
    const perfect = isBoardEmpty();

    clearTimer = setTimeout(() => {
      clearTimer = null;
      targets.forEach((k) => {
        const [r, c] = k.split(',').map(Number);
        cellEls[r][c].classList.remove('clearing');
      });
      state.busy = false;
      renderBoard();
      if (perfect) celebrateAllClear();
      finishTurn();
    }, 260);
  }

  /** 消去演出の予約を取り消し、演出用のクラスを片付ける。 */
  function cancelClearAnimation() {
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    state.busy = false;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) cellEls[r][c].classList.remove('clearing');
    }
    endAllClearEffect();
  }

  const isBoardEmpty = () => state.grid.every((row) => row.every((cell) => !cell));

  /** 全消し（盤面が空になった）ときのご褒美演出。 */
  function celebrateAllClear() {
    const center = (SIZE - 1) / 2;
    el.board.classList.add('allclear');
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        // 中心から遠いマスほど遅らせて、光が波紋状に広がるようにする。
        const delay = Math.round(Math.hypot(r - center, c - center) * 55);
        cellEls[r][c].style.setProperty('--delay', `${delay}ms`);
        cellEls[r][c].classList.add('spark');
      }
    }

    showCombo('✨ ALL CLEAR ✨', true);
    announce('全消し！');
    [523, 659, 784, 1047, 1319].forEach((freq, i) => {
      setTimeout(() => sound.play(freq, 0.25, 'triangle', 0.05), i * 90);
    });

    clearTimeout(allClearTimer);
    allClearTimer = setTimeout(endAllClearEffect, 1500);
  }

  function endAllClearEffect() {
    if (allClearTimer !== null) {
      clearTimeout(allClearTimer);
      allClearTimer = null;
    }
    el.board.classList.remove('allclear');
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        cellEls[r][c].classList.remove('spark');
        cellEls[r][c].style.removeProperty('--delay');
      }
    }
  }

  function addScore(points, animate) {
    state.score += points;
    if (state.score > state.best) {
      state.best = state.score;
      state.beatBest = true;
      store.set(STORAGE_KEY, String(state.best));
    }
    renderScore(animate);
  }

  function finishTurn() {
    if (state.tray.every((slot) => slot.used)) {
      refillTray();
    }
    renderTray();
    if (!state.tray.some((slot) => !slot.used && hasAnyPlacement(slot.piece))) {
      gameOver();
    }
  }

  /** 3 つとも置けない組み合わせは避けて配り直す（理不尽な即死を減らす）。 */
  function refillTray() {
    for (let attempt = 0; attempt < 30; attempt++) {
      const candidate = [randomPiece(), randomPiece(), randomPiece()];
      if (candidate.some((piece) => hasAnyPlacement(piece))) {
        state.tray = candidate.map((piece) => ({ piece, used: false }));
        return;
      }
    }
    state.tray = [randomPiece(), randomPiece(), randomPiece()]
      .map((piece) => ({ piece, used: false }));
  }

  function gameOver() {
    state.over = true;
    cancelDrag();
    el.finalScore.textContent = String(state.score);
    el.finalBest.textContent = String(state.best);
    el.panelTitle.textContent = 'GAME OVER';
    el.panelSub.textContent = state.beatBest
      ? '自己ベスト更新！'
      : '置ける場所がなくなりました';
    announce(`ゲームオーバー。スコア ${state.score} 点。`);
    el.overlay.hidden = false;
    document.getElementById('play-again').focus();
    sound.play(220, 0.3, 'sawtooth', 0.05);
    setTimeout(() => sound.play(160, 0.4, 'sawtooth', 0.05), 160);
  }

  /* ------------------------------------------------------------------ *
   * ドラッグ操作
   * ------------------------------------------------------------------ */

  let drag = null;

  function onPointerDown(event) {
    if (state.over || state.busy) return;
    const pieceEl = event.target.closest('.piece');
    if (!pieceEl || drag) return;

    const index = Number(pieceEl.dataset.index);
    const slot = state.tray[index];
    if (!slot || slot.used) return;

    event.preventDefault();
    deselectPiece(false);   // キーボードで選択中のカーソルと二重に出さない

    const metrics = boardMetrics();
    const ghost = buildPieceEl(slot.piece, metrics.size, 'drag-piece');
    el.dragLayer.appendChild(ghost);

    const width = slot.piece.cols * metrics.step - (metrics.step - metrics.size);
    const height = slot.piece.rows * metrics.step - (metrics.step - metrics.size);

    drag = {
      index,
      piece: slot.piece,
      el: ghost,
      sourceEl: pieceEl,
      metrics,
      width,
      height,
      // 指の少し上にピースを浮かせて、盤面が隠れないようにする。
      offsetX: width / 2,
      offsetY: height + metrics.size * 0.55,
      target: null,
      pointerId: event.pointerId,
    };

    pieceEl.classList.add('dragging');
    moveDrag(event.clientX, event.clientY);
  }

  function moveDrag(clientX, clientY) {
    if (!drag) return;
    const left = clientX - drag.offsetX;
    const top = clientY - drag.offsetY;
    const { x, y, step, size } = drag.metrics;
    const col = Math.round((left - x) / step);
    const row = Math.round((top - y) / step);

    // 盤面から大きく外れている間はプレビューを出さない。
    const outside = left + drag.width < x - size || left > x + SIZE * step ||
                    top + drag.height < y - size || top > y + SIZE * step;

    const valid = !outside && canPlaceAt(drag.piece, row, col);
    drag.target = valid ? { row, col } : null;

    // 置ける位置ではマス目にぴったり吸着させ、着地点を分かりやすくする。
    const px = valid ? x + col * step : left;
    const py = valid ? y + row * step : top;
    drag.el.style.transform = `translate(${px}px, ${py}px)`;

    if (outside) {
      clearPreview();
      return;
    }
    showPreview(drag.piece, row, col);
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    moveDrag(event.clientX, event.clientY);
  }

  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const target = drag.target;
    const index = drag.index;
    const piece = drag.piece;
    cancelDrag();
    if (target) {
      el.hint?.remove();
      placePiece(index, piece, target.row, target.col);
    }
  }

  function cancelDrag() {
    if (!drag) return;
    drag.el.remove();
    drag.sourceEl.classList.remove('dragging');
    clearPreview();
    drag = null;
  }

  /* ------------------------------------------------------------------ *
   * キーボード操作
   *   トレイでピースを選び、矢印キーで盤面のカーソルを動かして Enter で置く。
   * ------------------------------------------------------------------ */

  /** そのピースが最初に置ける位置。置ける場所がなければ null。 */
  function firstPlacement(piece) {
    for (let r = 0; r <= SIZE - piece.rows; r++) {
      for (let c = 0; c <= SIZE - piece.cols; c++) {
        if (canPlaceAt(piece, r, c)) return { row: r, col: c };
      }
    }
    return null;
  }

  function renderCursor() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) cellEls[r][c].classList.remove('cursor');
    }
    if (kb.index === null) {
      el.board.removeAttribute('aria-activedescendant');
      clearPreview();
      return;
    }
    const piece = state.tray[kb.index].piece;
    showPreview(piece, kb.row, kb.col);
    cellEls[kb.row][kb.col].classList.add('cursor');
    el.board.setAttribute('aria-activedescendant', cellEls[kb.row][kb.col].id);
  }

  function selectPiece(index) {
    if (state.over || state.busy) return;
    const slot = state.tray[index];
    if (!slot || slot.used) return;

    kb.index = index;
    const spot = firstPlacement(slot.piece) || { row: 0, col: 0 };
    kb.row = spot.row;
    kb.col = spot.col;
    markSelected(index);
    renderCursor();
    el.board.focus();
    announce(`${describePiece(slot.piece)} を選択。${kb.row + 1}行${kb.col + 1}列。` +
      '矢印キーで移動、Enter で配置、Escape で解除。');
  }

  /** 選択中の見た目だけを付け替える。トレイの DOM は作り直さない
   *  （ドラッグ開始時に呼ばれるため、掴んだ要素を消してしまわないように）。 */
  function markSelected(index) {
    el.tray.querySelectorAll('.piece.selected')
      .forEach((node) => node.classList.remove('selected'));
    if (index !== null) {
      el.tray.querySelector(`.piece[data-index="${index}"]`)?.classList.add('selected');
    }
  }

  function deselectPiece(focusTray) {
    if (kb.index === null) return;
    const index = kb.index;
    kb.index = null;
    renderCursor();
    markSelected(null);
    if (focusTray) el.tray.querySelector(`.piece[data-index="${index}"]`)?.focus();
  }

  /** まだ使っていないピースのうち、置ける場所があるものを選ぶ。 */
  function selectNextPiece() {
    const index = state.tray.findIndex((slot) => !slot.used && hasAnyPlacement(slot.piece));
    if (index >= 0) selectPiece(index);
  }

  function moveCursor(dr, dc) {
    const piece = state.tray[kb.index].piece;
    kb.row = Math.min(Math.max(kb.row + dr, 0), SIZE - piece.rows);
    kb.col = Math.min(Math.max(kb.col + dc, 0), SIZE - piece.cols);
    renderCursor();
    const ok = canPlaceAt(piece, kb.row, kb.col);
    announce(`${kb.row + 1}行${kb.col + 1}列${ok ? '' : ' 置けません'}`);
  }

  const ARROWS = {
    ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
  };

  function onBoardKeyDown(event) {
    if (state.over || state.busy) return;

    // ピース未選択なら、まずトレイから選ぶ。
    if (kb.index === null) {
      if (event.key === 'Enter' || event.key === ' ' || ARROWS[event.key]) {
        event.preventDefault();
        selectNextPiece();
      }
      return;
    }

    if (ARROWS[event.key]) {
      event.preventDefault();
      moveCursor(...ARROWS[event.key]);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const index = kb.index;
      const piece = state.tray[index].piece;
      if (placePiece(index, piece, kb.row, kb.col)) {
        el.hint?.remove();
        kb.index = null;
        renderCursor();
        // 続けて置けるよう、次のピースを自動で選ぶ（消去演出中は選べない）。
        if (!state.over && !state.busy) selectNextPiece();
      } else {
        announce('ここには置けません');
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      deselectPiece(true);
      announce('選択を解除しました');
    }
  }

  function onTrayKeyDown(event) {
    const pieceEl = event.target.closest('.piece');
    if (!pieceEl) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectPiece(Number(pieceEl.dataset.index));
    }
  }

  /* ------------------------------------------------------------------ *
   * 初期化
   * ------------------------------------------------------------------ */

  function newGame() {
    // 進行中のドラッグと、前のゲームに予約された消去演出を破棄してから始める。
    cancelDrag();
    cancelClearAnimation();
    kb.index = null;
    state.grid = emptyGrid();
    state.score = 0;
    state.combo = 0;
    state.over = false;
    state.beatBest = false;
    state.tray = [];
    refillTray();
    el.overlay.hidden = true;
    renderBoard();
    renderTray();
    renderCursor();
    renderScore(false);
  }

  function init() {
    state.best = Number(store.get(STORAGE_KEY) || 0);
    el.soundIcon.textContent = sound.on ? '🔊' : '🔇';
    el.soundBtn.classList.toggle('off', !sound.on);

    buildBoard();
    newGame();

    el.tray.addEventListener('pointerdown', onPointerDown);
    el.tray.addEventListener('keydown', onTrayKeyDown);
    el.board.addEventListener('keydown', onBoardKeyDown);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', (event) => {
      // 別の指のキャンセルで進行中のドラッグを巻き戻さない。
      if (drag && event.pointerId === drag.pointerId) cancelDrag();
    });
    window.addEventListener('blur', cancelDrag);

    document.getElementById('restart-btn').addEventListener('click', () => {
      if (state.score === 0 || confirm('最初からやり直しますか？')) newGame();
    });
    document.getElementById('play-again').addEventListener('click', newGame);
    el.soundBtn.addEventListener('click', () => sound.toggle());

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { cancelDrag(); renderTray(); }, 120);
    });

    // 盤面上でのスクロール／ピンチを抑止する。
    document.addEventListener('touchmove', (e) => {
      if (drag) e.preventDefault();
    }, { passive: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
