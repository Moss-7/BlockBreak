/* BlockBreak — ブロックブラスト風パズル
 * 8x8 の盤面に 3 つのピースをドラッグで配置し、行・列が埋まると消える。
 * 3 つとも置けなくなったらゲームオーバー。
 */
(() => {
  'use strict';

  const SIZE = 8;
  const LEGACY_BEST_KEY = 'blockbreak.best';
  const DIFFICULTY_KEY = 'blockbreak.difficulty';
  /** ハイスコアはむずかしさごとに分けて持つ。 */
  const bestKey = (difficulty) => `blockbreak.best.${difficulty}`;

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

  /* ------------------------------------------------------------------ *
   * 難易度（レベル）
   *
   *   レベル = 消したライン ÷ 10 + 1（最大 10）
   *   レベルが 1 上がるごとに、ちいさいピースが 4% 減って
   *   おおきいピースが 4% 増える。ふつうのピースはいつも 35%。
   *
   *   レベル 1 … ちいさい 50% / ふつう 35% / おおきい 15%
   *   レベル10 … ちいさい 14% / ふつう 35% / おおきい 51%
   * ------------------------------------------------------------------ */

  const MAX_LEVEL = 10;

  /* むずかしさ。変わるのは「揃いやすさ」に効く 2 つだけ。
   *   help  … 配られる 3 つに「いま消せるピース」が無いとき、
   *           1 つを消せるピースに差し替える確率
   *   lines … レベルが 1 つ上がるまでに消すライン数
   *           （レベルが上がるほど大きいピースが増える） */
  const DIFFICULTIES = {
    easy: {
      label: 'Easy',
      lines: 15,
      help: () => 100,
      desc: '消せるピースがいつも配られます。レベルは 15 本ごと。',
    },
    normal: {
      label: 'Normal',
      lines: 10,
      help: (level) => Math.max(0, 100 - (Math.min(level, MAX_LEVEL) - 1) * 10),
      desc: '消せるピースが配られやすいですが、レベルが上がるほど減ります。レベルは 10 本ごと。',
    },
    hard: {
      label: 'Hard',
      lines: 6,
      help: () => 0,
      desc: 'おたすけはありません。自分で消せる形を作ります。レベルは 6 本ごと。',
    },
  };
  const DEFAULT_DIFFICULTY = 'normal';

  const rules = () => DIFFICULTIES[state.difficulty] || DIFFICULTIES[DEFAULT_DIFFICULTY];
  const linesPerLevel = () => rules().lines;

  /* スコア。本家の攻略情報に合わせ、コンボは「加算式」にしている。
   *   ライン 1 本 = 50 点
   *   コンボボーナス = 20 点 + コンボが 1 つ増えるごとに +10 点
   * 同時消しへの上乗せは置かない。まとめて消すより、
   * 1〜2 本ずつ消してコンボを繋ぐ方が得になる。 */
  const LINE_POINTS = 50;
  const COMBO_BASE = 20;
  const COMBO_STEP = 10;
  const ALL_CLEAR_BONUS = 300;

  /* 配り直し。「3 つとも置ける」組み合わせを探す。
   * 盤面が詰まっていると見つからないので、見つかった中で
   * いちばん置ける数が多いものを使う。 */
  const REFILL_RETRIES = 30;

  /* おたすけの引き直し回数。確率はむずかしさごとに決まる。 */
  const HELP_RETRIES = 20;
  const SMALL_AT_LEVEL_1 = 50;
  const MEDIUM_SHARE = 35;
  const SHIFT_PER_LEVEL = 4;

  /** ピースの大きさ区分。マス数だけで決まる。 */
  const sizeGroup = (piece) => {
    if (piece.cells.length <= 3) return 'small';
    if (piece.cells.length === 4) return 'medium';
    return 'large';
  };

  const GROUPS = { small: [], medium: [], large: [] };
  PIECES.forEach((piece) => GROUPS[sizeGroup(piece)].push(piece));

  const GROUP_WEIGHT = {};
  for (const [name, list] of Object.entries(GROUPS)) {
    GROUP_WEIGHT[name] = list.reduce((sum, p) => sum + p.weight, 0);
  }

  /** そのレベルでの、大きさ区分ごとの出現率（合計 100）。 */
  function groupShares(level) {
    const step = Math.min(level, MAX_LEVEL) - 1;
    return {
      small: SMALL_AT_LEVEL_1 - step * SHIFT_PER_LEVEL,
      medium: MEDIUM_SHARE,
      large: (100 - SMALL_AT_LEVEL_1 - MEDIUM_SHARE) + step * SHIFT_PER_LEVEL,
    };
  }

  /** 区分の中では、これまでどおり基本形の weight どおりに選ぶ。 */
  function pickFromGroup(name) {
    const list = GROUPS[name];
    let n = Math.random() * GROUP_WEIGHT[name];
    for (const piece of list) {
      n -= piece.weight;
      if (n <= 0) return piece;
    }
    return list[list.length - 1];
  }

  /** レベルに応じた大きさの偏りでピースを 1 つ選ぶ。
   *  group を渡すと、その区分だけから選ぶ（ごほうびタイム用）。 */
  function randomPiece(group) {
    if (group) return pickFromGroup(group);

    const shares = groupShares(state.level);
    let n = Math.random() * 100;
    for (const name of ['small', 'medium', 'large']) {
      n -= shares[name];
      if (n <= 0) return pickFromGroup(name);
    }
    return pickFromGroup('large');
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
    lines: 0,        // 消したラインの合計
    level: 1,
    bonusNext: false, // 次に配る 3 つをごほうび（ちいさいピース）にする
    bonusTray: false, // 今のトレイがごほうびで配られたものか
    difficulty: DEFAULT_DIFFICULTY,
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
    level: document.getElementById('level'),
    levelBar: document.getElementById('level-bar'),
    levelFill: document.getElementById('level-fill'),
    levelNext: document.getElementById('level-next'),
    bonus: document.getElementById('bonus'),
    settings: document.getElementById('settings'),
    settingsBtn: document.getElementById('settings-btn'),
    difficultyChip: document.getElementById('difficulty-chip'),
    difficultyDesc: document.getElementById('difficulty-desc'),
    soundToggle: document.getElementById('sound-toggle'),
  };

  /** スクリーンリーダー向けに状況を読み上げる。 */
  function announce(text) {
    el.status.textContent = text;
  }

  /** どの版が動いているかを隅に表示する。
   *  公開時はワークフローがコミットの短縮 SHA と時刻を埋め込む。 */
  function renderBuildInfo() {
    const node = document.getElementById('build');
    if (!node) return;
    const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || '';
    const version = meta('app-version') || '?';
    const sha = meta('build-sha');
    const builtAt = meta('build-at');
    // 置き換えられていなければローカル実行。
    const built = sha && !sha.startsWith('__');

    node.textContent = '';
    const label = document.createTextNode(`v${version} · `);
    node.appendChild(label);

    if (built) {
      const link = document.createElement('a');
      link.href = `https://github.com/Moss-7/BlockBreak/commit/${sha}`;
      link.textContent = sha;
      link.target = '_blank';
      link.rel = 'noopener';
      node.appendChild(link);
      if (builtAt && !builtAt.startsWith('__')) {
        node.appendChild(document.createTextNode(` · ${builtAt}`));
      }
    } else {
      node.appendChild(document.createTextNode('dev'));
    }
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

  function renderLevel() {
    const maxed = state.level >= MAX_LEVEL;
    const per = linesPerLevel();
    const done = maxed ? per : state.lines % per;
    el.level.textContent = String(state.level);
    el.levelFill.style.width = `${(done / per) * 100}%`;
    el.levelBar.setAttribute('aria-valuenow', String(done));
    el.levelNext.textContent = maxed
      ? 'さいだいレベル'
      : `つぎまで あと ${per - done} 本`;
  }

  function renderBonus() {
    el.bonus.hidden = !state.bonusTray;
  }

  function renderDifficulty() {
    const current = rules();
    el.difficultyChip.textContent = current.label;
    el.difficultyDesc.textContent = current.desc;
    el.settings.querySelectorAll('.seg').forEach((seg) => {
      seg.setAttribute('aria-checked', String(seg.dataset.difficulty === state.difficulty));
    });
  }

  function renderSound() {
    el.soundIcon.textContent = sound.on ? '🔊' : '🔇';
    el.soundBtn.classList.toggle('off', !sound.on);
    el.soundToggle.textContent = sound.on ? 'オン' : 'オフ';
    el.soundToggle.setAttribute('aria-pressed', String(sound.on));
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

  const TICK_INTERVAL = 30;   // 移動音を鳴らす最短間隔（ms）

  const sound = {
    on: store.get('blockbreak.sound') !== 'off',
    ctx: null,
    master: null,
    lastTick: 0,

    /** AudioContext を用意する。使えない環境では null を返す。 */
    ready() {
      if (!this.on) return null;
      try {
        if (!this.ctx) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return null;
          this.ctx = new Ctx();
          this.master = this.ctx.createGain();
          this.master.gain.value = 0.9;
          this.master.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
      } catch (_) {
        return null;
      }
    },

    /** 単音。立ち上がりを少し取って「プツッ」というノイズを防ぐ。
     *  to を渡すと freq から to へ滑らせる。 */
    tone({ freq, to, dur = 0.12, type = 'triangle', gain = 0.06, delay = 0 }) {
      const ctx = this.ready();
      if (!ctx) return;
      try {
        const t0 = ctx.currentTime + delay;
        const osc = ctx.createOscillator();
        const amp = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
        amp.gain.setValueAtTime(0.0001, t0);
        amp.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.012, dur / 3));
        amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(amp).connect(this.master);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      } catch (_) { /* サウンド非対応環境では無視 */ }
    },

    /** 音を順番に鳴らす。 */
    seq(notes, { step = 0.09, ...opts } = {}) {
      notes.forEach((freq, i) => this.tone({ freq, delay: i * step, ...opts }));
    },

    // --- 場面ごとの音 ---

    /** ピースを掴んだ／選んだ */
    pick() {
      this.tone({ freq: 440, to: 660, dur: 0.09, type: 'triangle', gain: 0.05 });
    },

    /** 置く位置が隣のマスへ動いた。ドラッグ中は何度も呼ばれるので間引く。 */
    tick(placeable) {
      const now = performance.now();
      if (now - this.lastTick < TICK_INTERVAL) return;
      this.lastTick = now;
      if (placeable) {
        this.tone({ freq: 1180, dur: 0.035, type: 'square', gain: 0.022 });
      } else {
        this.tone({ freq: 190, dur: 0.05, type: 'sine', gain: 0.03 });
      }
    },

    /** 盤面に置いた。大きいピースほど低い音になる。 */
    drop(cells) {
      this.tone({ freq: 320 + cells * 16, to: 190 + cells * 10, dur: 0.11, type: 'square', gain: 0.05 });
    },

    /** 置かずに戻した／選択を解除した */
    cancel() {
      this.tone({ freq: 380, to: 240, dur: 0.11, type: 'triangle', gain: 0.04 });
    },

    /** 置けない場所で決定した */
    blocked() {
      this.tone({ freq: 150, dur: 0.14, type: 'sawtooth', gain: 0.04 });
    },

    /** ライン消去。同時に消すほど音が高く積み上がる。 */
    clear(lineCount, combo) {
      this.seq([523, 659, 784, 988, 1175].slice(0, Math.min(lineCount, 5)),
        { step: 0.07, dur: 0.2, type: 'triangle', gain: 0.055 });
      if (combo >= 2) {
        this.tone({ freq: 1568, dur: 0.22, type: 'triangle', gain: 0.045, delay: 0.14 });
      }
    },

    levelUp() {
      this.seq([660, 880, 1170], { step: 0.1, dur: 0.22, type: 'triangle', gain: 0.055 });
    },

    allClear() {
      this.seq([523, 659, 784, 1047, 1319], { step: 0.09, dur: 0.28, type: 'triangle', gain: 0.055 });
    },

    gameOver() {
      this.tone({ freq: 300, to: 110, dur: 0.7, type: 'sawtooth', gain: 0.05 });
    },

    /** ボタン操作 */
    ui() {
      this.tone({ freq: 720, dur: 0.06, type: 'triangle', gain: 0.04 });
    },

    toggle() {
      this.on = !this.on;
      store.set('blockbreak.sound', this.on ? 'on' : 'off');
      renderSound();
      if (this.on) this.ui();
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
    sound.drop(piece.cells.length);

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

    // ライン 1 本 50 点 + コンボボーナス（20 点から 10 点ずつ増える）。
    const points = lineCount * LINE_POINTS + COMBO_BASE + (state.combo - 1) * COMBO_STEP;
    addScore(points, true);
    popScore(points, anchorRow, anchorCol);

    // 消したライン 10 本ごとにレベルが 1 つ上がる。
    state.lines += lineCount;
    const level = Math.min(Math.floor(state.lines / linesPerLevel()) + 1, MAX_LEVEL);
    const leveledUp = level > state.level;
    state.level = level;
    renderLevel();

    if (leveledUp) {
      showCombo(`レベル ${level} になった！`, true);
      announce(`レベル ${level} になりました。ピースが少し大きくなります。`);
      sound.levelUp();
    } else if (lineCount >= 2 || state.combo >= 2) {
      const parts = [];
      if (state.combo >= 2) parts.push(`${state.combo} COMBO!`);
      if (lineCount >= 2) parts.push(`${lineCount} LINES!`);
      showCombo(parts.join('  '));
    }

    if (lineCount >= 2 || state.combo >= 2) {
      el.board.classList.add('shake');
      setTimeout(() => el.board.classList.remove('shake'), 300);
    }

    sound.clear(lineCount, state.combo);

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

  /** 全消し（盤面が空になった）ときのご褒美。
   *  ボーナス点に加えて、次に配る 3 つをちいさいピースにする。 */
  function celebrateAllClear() {
    addScore(ALL_CLEAR_BONUS, true);
    popScore(ALL_CLEAR_BONUS, (SIZE - 1) / 2, (SIZE - 1) / 2);
    state.bonusNext = true;

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

    showCombo(`✨ ALL CLEAR ✨ +${ALL_CLEAR_BONUS}`, true);
    announce(`全消し！ ボーナス ${ALL_CLEAR_BONUS} 点。つぎの 3 つはちいさいピースです。`);
    sound.allClear();

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
      store.set(bestKey(state.difficulty), String(state.best));
    }
    renderScore(animate);
  }

  function finishTurn() {
    if (state.tray.every((slot) => slot.used)) {
      refillTray();
      renderBonus();
      if (state.bonusTray) announce('ごほうびタイム。ちいさいピースが 3 つ配られました。');
    }
    renderTray();
    if (!state.tray.some((slot) => !slot.used && hasAnyPlacement(slot.piece))) {
      gameOver();
    }
  }

  /** そのピースを置いてラインを消せる場所があるか。 */
  function canClearLine(piece) {
    for (let r = 0; r <= SIZE - piece.rows; r++) {
      for (let c = 0; c <= SIZE - piece.cols; c++) {
        if (!canPlaceAt(piece, r, c)) continue;
        const { rows, cols } = linesAfterPlacing(piece, r, c);
        if (rows.length + cols.length > 0) return true;
      }
    }
    return false;
  }

  /** 3 つを配る。
   *  1. できるだけ「3 つとも置ける」組み合わせを選ぶ。
   *     トレイは 3 つ使い切るまで補充されないので、置けないピースが
   *     混じると数手後に必ず詰む。
   *  2. レベルが低いうちは「いま消せるピース」を 1 つ混ぜる（おたすけ）。
   *  全消しの直後は「ごほうびタイム」として、ちいさいピースだけを配る。 */
  function refillTray() {
    const group = state.bonusNext ? 'small' : null;
    state.bonusTray = state.bonusNext;
    state.bonusNext = false;

    const deal = () => [randomPiece(group), randomPiece(group), randomPiece(group)];
    const fitCount = (list) => list.filter((piece) => hasAnyPlacement(piece)).length;

    let candidate = deal();
    let fits = fitCount(candidate);
    for (let attempt = 0; attempt < REFILL_RETRIES && fits < 3; attempt++) {
      const next = deal();
      const nextFits = fitCount(next);
      if (nextFits > fits) {
        candidate = next;
        fits = nextFits;
      }
    }

    if (!candidate.some(canClearLine) && Math.random() * 100 < rules().help(state.level)) {
      for (let attempt = 0; attempt < HELP_RETRIES; attempt++) {
        const piece = randomPiece(group);
        // 置ける数を減らさないよう、置き場所があるものだけを混ぜる。
        if (hasAnyPlacement(piece) && canClearLine(piece)) {
          candidate[Math.floor(Math.random() * candidate.length)] = piece;
          break;
        }
      }
    }

    state.tray = candidate.map((piece) => ({ piece, used: false }));
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
    sound.gameOver();
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
      lastCell: undefined,   // 直前に狙っていたマス。変わったときだけ音を鳴らす。
      pointerId: event.pointerId,
    };

    pieceEl.classList.add('dragging');
    sound.pick();
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

    // 狙うマスが変わった瞬間だけ鳴らす（置けるかどうかで音を変える）。
    const cellKey = outside ? null : `${row},${col}`;
    if (cellKey !== drag.lastCell) {
      // 掴んだ直後の 1 回は、掴んだ音と重なるので鳴らさない。
      const justPicked = drag.lastCell === undefined;
      drag.lastCell = cellKey;
      if (!justPicked && cellKey !== null) sound.tick(valid);
    }

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
    } else {
      sound.cancel();   // 置かずに戻した
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
    sound.pick();
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
    sound.tick(ok);
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
        sound.blocked();
        announce('ここには置けません');
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      deselectPiece(true);
      sound.cancel();
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
   * 設定画面
   * ------------------------------------------------------------------ */

  let settingsOpener = null;   // 閉じたときにフォーカスを戻す先

  function openSettings() {
    settingsOpener = document.activeElement;
    cancelDrag();
    deselectPiece(false);
    renderDifficulty();
    renderSound();
    el.settings.hidden = false;
    el.settings.querySelector('.seg[aria-checked="true"]')?.focus();
    sound.ui();
  }

  function closeSettings() {
    if (el.settings.hidden) return;
    el.settings.hidden = true;
    sound.ui();
    (settingsOpener || el.settingsBtn).focus?.();
    settingsOpener = null;
  }

  /** むずかしさを変えると配られ方が変わるので、その場で新しいゲームにする。 */
  function changeDifficulty(difficulty) {
    if (!DIFFICULTIES[difficulty]) return;
    if (difficulty === state.difficulty) return;
    const playing = state.score > 0 && !state.over;
    if (playing && !confirm('むずかしさを変えると、さいしょからやり直しになります。いいですか？')) {
      return;
    }
    state.difficulty = difficulty;
    store.set(DIFFICULTY_KEY, difficulty);
    state.best = Number(store.get(bestKey(difficulty)) || 0);
    renderDifficulty();
    newGame();
    announce(`むずかしさを ${rules().label} にしました。`);
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
    state.lines = 0;
    state.level = 1;
    state.bonusNext = false;
    state.bonusTray = false;
    state.tray = [];
    refillTray();
    el.overlay.hidden = true;
    renderBoard();
    renderTray();
    renderCursor();
    renderScore(false);
    renderLevel();
    renderBonus();
  }

  /** むずかしさ別のハイスコアへ移行する。
   *  むずかしさが無かった頃の記録は Normal のものとして引き継ぐ。 */
  function loadRecords() {
    const saved = store.get(DIFFICULTY_KEY);
    state.difficulty = DIFFICULTIES[saved] ? saved : DEFAULT_DIFFICULTY;

    const legacy = store.get(LEGACY_BEST_KEY);
    if (legacy !== null && store.get(bestKey(DEFAULT_DIFFICULTY)) === null) {
      store.set(bestKey(DEFAULT_DIFFICULTY), legacy);
    }
    state.best = Number(store.get(bestKey(state.difficulty)) || 0);
  }

  function init() {
    loadRecords();
    renderSound();
    renderDifficulty();

    renderBuildInfo();
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
      sound.ui();
      if (state.score === 0 || confirm('最初からやり直しますか？')) newGame();
    });
    document.getElementById('play-again').addEventListener('click', () => {
      sound.ui();
      newGame();
    });
    el.soundBtn.addEventListener('click', () => sound.toggle());
    el.soundToggle.addEventListener('click', () => sound.toggle());

    el.settingsBtn.addEventListener('click', openSettings);
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    el.settings.addEventListener('click', (event) => {
      // パネルの外側を押したら閉じる。
      if (event.target === el.settings) closeSettings();
      const seg = event.target.closest('.seg');
      if (seg) changeDifficulty(seg.dataset.difficulty);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !el.settings.hidden) {
        event.preventDefault();
        closeSettings();
      }
    });

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
