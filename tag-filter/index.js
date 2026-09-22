/**
 * 插件标签筛选 —— EchoMusic 插件（id: tag-filter）
 *
 * 作用：在「设置 → 插件」（插件管理）面板里注入一条标签筛选条，
 *      自动把面板中所有插件的标签聚合出来供点选，实时过滤卡片列表。
 *
 * 为什么是「读宿主 DOM + 隐藏卡片」，而不是驱动宿主的搜索框：
 *   ① 宿主的搜索框只做文本匹配，表达不了「同时满足多个标签」；
 *   ② 卡片上的标签本来就是宿主渲染出来的，直接读它最准，
 *      而且「已安装」与「在线插件」两个视图结构一致，一套代码全覆盖；
 *   ③ 不需要任何新的宿主 API，也就不会因为宿主版本收紧能力而失效。
 *
 * 宿主 DOM 契约（2026-09-23 用 app.asar 逐字节核验，EchoMusic v2.3.2-beta.6）：
 *   .plugin-content                插件管理页的内容容器（两种视图共用一个）
 *   .plugin-card-grid              卡片网格；**骨架屏那一版带 aria-busy="true"**
 *   .plugin-card <article>         单张插件卡片（已安装 / 在线插件结构一致）
 *   .plugin-card-name   <h3>       插件显示名
 *   .marketplace-tags > span       目录标签（来自 echo-plugins.json 的 tags，
 *                                  宿主持久化在 app_kv 的 plugins:catalog-tags:<id>）
 *   .plugin-feature-tags > span    能力标签（由 manifest.capabilities 生成）
 *   .plugin-card-id                「ID: <pluginId>」
 *
 * 三个必须记住的坑：
 *   1) 骨架屏卡片同样带 .plugin-card / .marketplace-tags，只能靠**网格的
 *      aria-busy="true"** 区分；否则加载期间会把占位标签当成真标签聚合出来。
 *   2) 隐藏卡片用**行内 style.display**，不要用 class：宿主卡片的 class 是
 *      `class:r([...])` 动态绑定，一旦卡片状态变化（启用/停用/可更新）Vue 会
 *      整串重写 el.className，把手加的 class 抹掉。行内 style 宿主从不触碰。
 *   3) 渲染函数里读的必须是响应式数据（view.* / settings.*）。插件的选中集合与
 *      匹配模式是普通变量，界面上要一律经 view.selected / view.mode 读，
 *      否则点了没反应。
 *
 * 为什么不直接用 ctx.dom.observe：
 *   它的语义是「每个新出现的匹配元素只回调一次」（按元素去重），宿主机内原地
 *   重渲染卡片时不会再触发，用来做「实时过滤」会漏更新。所以这里自己起一个
 *   MutationObserver（只监听 childList / aria-busy）+ 一个 1s 兜底轮询，
 *   并且**每次同步只写有变化的节点**，不会产生 DOM 抖动。
 */

const STORAGE_KEY = 'tag-filter-store'

/** 「未标注」伪标签：给没有任何标签的卡片一个可筛选的身份，用户不会漏掉它们 */
const UNTAGGED_KEY = '\u0000untagged'
const UNTAGGED_LABEL = '未标注'

const MATCH_MODES = {
  any: { id: 'any', label: '任一', title: '选中多个标签时，只要插件带其中任意一个标签就会显示' },
  all: { id: 'all', label: '全部', title: '选中多个标签时，插件必须同时带有全部标签才会显示' }
}

const DEFAULT_SETTINGS = {
  /** 在插件管理面板注入筛选条 */
  enableFilterBar: true,
  /** 侧边栏「插件」分组里的「标签筛选」入口 */
  showSidebarEntry: true,
  /** 把选中标签与匹配模式写进插件存储，重启后恢复 */
  persistSelection: true,
  /** 默认匹配方式 */
  defaultMode: 'any',
  /** 在标签上显示该标签在当前视图里的插件数量 */
  showCounts: true,
  /** 同时纳入「能力标签」（由 manifest.capabilities 生成） */
  includeFeatureTags: false,
  debug: false
}

/** 宿主 DOM 选择器 */
const DOM = {
  content: '.plugin-content',
  grid: '.plugin-card-grid',
  card: '.plugin-card',
  cardName: '.plugin-card-name',
  cardId: '.plugin-card-id',
  tags: '.marketplace-tags',
  featureTags: '.plugin-feature-tags'
}
const BUSY_ATTR = 'aria-busy'

/** 兜底轮询间隔：MutationObserver 覆盖不到的「原地重渲染」靠它收敛 */
const POLL_MS = 1000
/** DOM 变更后的合并窗口，避免一次重渲染触发几十次同步 */
const SYNC_DEBOUNCE_MS = 60
/** 快照最多记住多少个插件（写进宿主 app_kv，别无限膨胀） */
const SNAPSHOT_MAX = 400
/** 单个插件最多记住多少个标签 */
const SNAPSHOT_TAGS_MAX = 16

/* ====================================================================== *
 * 纯函数区：不依赖 activate 闭包，可被无头测试与变异测试直接调用
 * ====================================================================== */

/** 压空白、去首尾、限长；标签来自第三方索引，不能信它有多干净 */
function normalizeText(value, max) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return text.length > max ? text.slice(0, max) : text
}

function normalizeTag(value) {
  return normalizeText(value, 40)
}

/** 标签身份键：大小写不敏感（上游索引里 `Lyrics` 与 `lyrics` 都出现过） */
function tagKeyOf(value) {
  return normalizeTag(value).toLowerCase()
}

/** 宿主渲染成 `ID: tag-filter`（兼容全角冒号与多余空格），去掉前缀才是真 id */
function stripIdPrefix(value) {
  return normalizeText(value, 120).replace(/^ID\s*[:：]\s*/i, '')
}

function isBusyGrid(grid) {
  if (!grid || typeof grid.getAttribute !== 'function') return false
  return String(grid.getAttribute(BUSY_ATTR) || '').toLowerCase() === 'true'
}

/** 元素的可见文本（标签是 <span> 纯文本，直接 textContent） */
function textOf(el) {
  if (!el) return ''
  const raw = typeof el.textContent === 'string' ? el.textContent : ''
  return raw.replace(/\s+/g, ' ').trim()
}

/** 判断一组标签是否命中当前选择 */
function matchesSelection(tagKeys, selectedKeys, mode) {
  const tags = tagKeys instanceof Set ? tagKeys : new Set(Array.isArray(tagKeys) ? tagKeys : [])
  const keys = Array.isArray(selectedKeys) ? selectedKeys : Array.from(selectedKeys || [])
  if (keys.length === 0) return true
  if (mode === 'all') {
    for (const key of keys) if (!tags.has(key)) return false
    return true
  }
  for (const key of keys) if (tags.has(key)) return true
  return false
}

/** 实体身份：优先插件 id，退化为显示名 */
function pickEntityKey(id, name) {
  if (id) return `id:${id}`
  if (name) return `name:${name}`
  return ''
}

/**
 * 从一张卡片读取标签。
 *
 * 只读 `.marketplace-tags` 里的 <span>（目录标签）；`includeFeatureTags` 打开时
 * 追加 `.plugin-feature-tags`（能力标签，如「网络」「本地文件」），并用 capability
 * 标记出来，界面上会给出不同的提示，避免两种标签体系被混为一谈。
 */
function readCardTags(card, includeFeatureTags) {
  const out = []
  const seen = new Set()
  const collect = (container, capability) => {
    if (!container || typeof container.querySelectorAll !== 'function') return
    for (const span of Array.from(container.querySelectorAll('span'))) {
      const label = normalizeTag(textOf(span))
      if (!label) continue
      const key = tagKeyOf(label)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({ key, label, capability: !!capability })
    }
  }
  if (card && typeof card.querySelector === 'function') {
    collect(card.querySelector(DOM.tags), false)
    if (includeFeatureTags) collect(card.querySelector(DOM.featureTags), true)
  }
  return out
}

/** 按 key 去重：同一插件重复出现同名标签（大小写不同也算）会算成两个，必须先去重再统计 */
function dedupeTags(tags) {
  const out = []
  const seen = new Set()
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (!tag || !tag.key || seen.has(tag.key)) continue
    seen.add(tag.key)
    out.push(tag)
  }
  return out
}

/**
 * 卡片记录 → 插件实体。
 * 同一插件可能在页面上出现两次（宿主允许插件管理页被挂载多处），
 * 所以按身份合并、把元素收进 elements 数组，过滤时一起处理。
 */
function mergeRecords(records) {
  const map = new Map()
  for (const record of records) {
    const key = pickEntityKey(record.id, record.name)
    if (!key) continue
    let entity = map.get(key)
    if (!entity) {
      entity = { key, id: record.id, name: record.name, tags: [], tagKeys: new Set(), elements: [] }
      map.set(key, entity)
    }
    if (record.el) entity.elements.push(record.el)
    // 两次挂载给出的标签应当一致；取第一个非空的，避免空的把非空的覆盖掉
    if (entity.tags.length === 0 && record.tags && record.tags.length) {
      const tags = dedupeTags(record.tags)
      entity.tags = tags
      entity.tagKeys = new Set(tags.map((tag) => tag.key))
    }
  }
  for (const entity of map.values()) {
    if (entity.tags.length === 0) {
      entity.tags = [{ key: UNTAGGED_KEY, label: UNTAGGED_LABEL, untagged: true }]
      entity.tagKeys = new Set([UNTAGGED_KEY])
    }
  }
  return Array.from(map.values())
}

/** 从持久化的快照重建实体（没有 DOM 元素，只用于标签总览与统计） */
function entitiesFromSnapshot(items) {
  const records = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue
    const tags = dedupeTags(
      (Array.isArray(item.tags) ? item.tags : [])
        .map((tag) => normalizeTag(tag))
        .filter(Boolean)
        .slice(0, SNAPSHOT_TAGS_MAX)
        .map((label) => ({ key: tagKeyOf(label), label, capability: false }))
    )
    records.push({
      el: null,
      id: normalizeText(item.id, 120),
      name: normalizeText(item.name, 120),
      tags
    })
  }
  return mergeRecords(records)
}

/** 选择状态 → 统计 */
function matchStats(entities, selectedKeys, mode) {
  const total = entities.length
  if (!selectedKeys.length) return { total, matched: total, hidden: 0 }
  let matched = 0
  for (const entity of entities) {
    if (matchesSelection(entity.tagKeys, selectedKeys, mode)) matched += 1
  }
  return { total, matched, hidden: total - matched }
}

/**
 * 生成标签 chip 列表。
 *
 * - `count`：当前视图里带这个标签的插件数（稳定值，不随选择变化）→ 展示与排序用它；
 * - `alive`：**把该标签加入当前选择后**还会匹配多少插件 → 「选中后共 N 个匹配」提示用它；
 * - `dead`：加入后一个都不匹配（只可能出现在未选中的 chip 上）→ 视觉上弱化。
 *
 * 排序刻意只用 count + 标签名，不掺 alive：否则点一下标签整排顺序就变，
 * 光标下的 chip 会跳走。
 */
function buildChips(entities, selectedKeys, mode, labels) {
  const selectedSet = new Set(selectedKeys)
  const presence = new Map()
  for (const entity of entities) {
    for (const tag of entity.tags) {
      const current = presence.get(tag.key)
      if (current) current.count += 1
      else {
        presence.set(tag.key, {
          key: tag.key,
          label: tag.label,
          capability: !!tag.capability,
          untagged: !!tag.untagged,
          count: 1
        })
      }
    }
  }
  // 已选但在当前视图里不存在的标签也要列出来，否则用户没法取消它（切视图时会遇到）
  for (const key of selectedKeys) {
    if (presence.has(key)) continue
    presence.set(key, {
      key,
      label: (labels && labels.get(key)) || (key === UNTAGGED_KEY ? UNTAGGED_LABEL : key),
      capability: false,
      untagged: key === UNTAGGED_KEY,
      count: 0
    })
  }

  const chips = []
  for (const entry of presence.values()) {
    const withKey = selectedSet.has(entry.key) ? selectedKeys : selectedKeys.concat(entry.key)
    let alive = 0
    for (const entity of entities) {
      if (matchesSelection(entity.tagKeys, withKey, mode)) alive += 1
    }
    chips.push({
      key: entry.key,
      label: entry.label,
      capability: entry.capability,
      untagged: entry.untagged,
      count: entry.count,
      alive,
      selected: selectedSet.has(entry.key),
      dead: alive === 0 && !selectedSet.has(entry.key)
    })
  }
  chips.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
  return chips
}

/** chip 列表是否等价（避免每秒重建导致的无意义重渲染） */
function sameChips(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (!x || !y) return false
    if (
      x.key !== y.key ||
      x.label !== y.label ||
      x.count !== y.count ||
      x.alive !== y.alive ||
      x.selected !== y.selected ||
      x.dead !== y.dead
    ) {
      return false
    }
  }
  return true
}

/* ====================================================================== *
 * 插件入口
 * ====================================================================== */

export async function activate(ctx) {
  const { h, reactive, defineComponent } = ctx.vue

  /* ---------- 基础 ---------- */

  const log = (...args) => {
    if (settings.debug) console.log('[tag-filter]', ...args)
  }

  const toast = (level, message) => {
    try {
      if (ctx.toast && typeof ctx.toast[level] === 'function') ctx.toast[level](message)
    } catch (error) {
      log('提示失败', error)
    }
  }

  /* ---------- 状态 ---------- *
   * settings 必须是 reactive：设置面板与筛选条都直接读它渲染。
   * 选中集合 / 匹配模式是普通变量，界面上一律经 view.selected / view.mode 读。
   */

  const settings = reactive({ ...DEFAULT_SETTINGS })
  let selection = []
  let mode = DEFAULT_SETTINGS.defaultMode

  /** 最近一次 DOM 扫描到的实体（含元素引用，**不能**塞进 reactive） */
  let liveEntities = []
  /** 快照实体是**派生**的：按 snapshot.items 的对象身份缓存，避免每秒重建，也不可能与快照脱节 */
  let snapshotCacheKey = null
  let snapshotCacheValue = []
  let snapshot = { at: 0, source: '', items: [], fingerprint: '' }
  /** key → 展示名，用于当前视图里不存在的已选标签 */
  const labels = new Map()

  /** 被我们改过 display 的元素，停用时逐个还原 */
  const touched = new Set()

  const hosts = new Map()
  let observer = null
  let pollTimer = null
  let syncTimer = null
  let saveTimer = null
  let disposed = false
  /** 上一次落进 reactive 的数据指纹，用来避免无意义重渲染 */
  let lastSig = ''

  const view = reactive({
    visible: false,
    chips: [],
    selected: [],
    mode: DEFAULT_SETTINGS.defaultMode,
    total: 0,
    matched: 0,
    hidden: 0,
    tagCount: 0,
    untaggedCount: 0,
    noMatch: false,
    source: 'live',
    barFocused: false
  })

  /** 独立页面用的目录（实时扫描优先，否则用快照） */
  const catalog = reactive({
    at: 0,
    source: '',
    total: 0,
    chipCount: 0,
    chips: [],
    fromSnapshot: true
  })

  /**
   * 快照 → 实体。
   * 刻意做成「派生」而不是另存一份：只要 snapshot.items 还是同一个数组就复用，
   * 换了就重建。这样「面板里实时读到的标签」与「面板关掉后页面上看到的标签」
   * 永远来自同一处，也不会出现两边不同步。
   */
  function snapshotEntities() {
    if (snapshotCacheKey !== snapshot.items) {
      snapshotCacheKey = snapshot.items
      snapshotCacheValue = snapshot.items.length ? entitiesFromSnapshot(snapshot.items) : []
    }
    return snapshotCacheValue
  }

  const currentEntities = () => (liveEntities.length ? liveEntities : snapshotEntities())

  /* ---------- 持久化 ---------- */

  function buildSnapshotItems(entities) {
    const items = []
    for (const entity of entities.slice(0, SNAPSHOT_MAX)) {
      const untaggedOnly = entity.tags.length === 1 && entity.tags[0].untagged
      items.push({
        id: entity.id || '',
        name: entity.name || '',
        tags: untaggedOnly ? [] : entity.tags.map((tag) => tag.label).slice(0, SNAPSHOT_TAGS_MAX)
      })
    }
    return items
  }

  function scheduleSave() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persist()
    }, 400)
  }

  async function persist() {
    if (!ctx.storage || typeof ctx.storage.set !== 'function') return
    const payload = {
      settings: { ...settings },
      selection: settings.persistSelection ? selection.slice() : [],
      mode: settings.persistSelection ? mode : settings.defaultMode,
      snapshot: {
        at: snapshot.at,
        source: snapshot.source,
        items: snapshot.items
      }
    }
    try {
      await ctx.storage.set(STORAGE_KEY, payload)
    } catch (error) {
      log('保存失败', error)
    }
  }

  function applyLoaded(saved) {
    Object.assign(settings, DEFAULT_SETTINGS)
    if (saved && saved.settings && typeof saved.settings === 'object') {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (saved.settings[key] !== undefined) settings[key] = saved.settings[key]
      }
    }
    if (!MATCH_MODES[settings.defaultMode]) settings.defaultMode = DEFAULT_SETTINGS.defaultMode
    mode = settings.defaultMode

    if (saved && settings.persistSelection) {
      if (Array.isArray(saved.selection)) {
        selection = saved.selection.map((key) => normalizeText(key, 60)).filter(Boolean)
      }
      if (MATCH_MODES[saved.mode]) mode = saved.mode
    }
    selection = Array.from(new Set(selection))

    const raw = saved && saved.snapshot && typeof saved.snapshot === 'object' ? saved.snapshot : null
    if (raw) {
      snapshot = {
        at: Number(raw.at) || 0,
        source: normalizeText(raw.source, 20),
        items: Array.isArray(raw.items) ? raw.items : [],
        fingerprint: ''
      }
    }
  }

  /* ---------- DOM 扫描 ---------- */

  function cardQuery(card, selector) {
    if (!card || typeof card.querySelector !== 'function') return null
    return card.querySelector(selector)
  }

  function scanLive() {
    if (typeof document === 'undefined') return []
    const records = []
    for (const grid of Array.from(document.querySelectorAll(DOM.grid))) {
      // 骨架屏网格：里面的 .plugin-card 是占位卡片，标签也是假的
      if (isBusyGrid(grid)) continue
      if (typeof grid.querySelectorAll !== 'function') continue
      for (const card of Array.from(grid.querySelectorAll(DOM.card))) {
        const id = stripIdPrefix(textOf(cardQuery(card, DOM.cardId)))
        const name = normalizeText(textOf(cardQuery(card, DOM.cardName)), 120)
        if (!id && !name) continue
        records.push({ el: card, id, name, tags: readCardTags(card, settings.includeFeatureTags) })
      }
    }
    return mergeRecords(records)
  }

  function rememberLabels(entities) {
    for (const entity of entities) {
      for (const tag of entity.tags) {
        if (tag.untagged) continue
        if (!labels.has(tag.key)) labels.set(tag.key, tag.label)
      }
    }
  }

  /* ---------- 过滤 ---------- */

  function applyFilter() {
    for (const entity of liveEntities) {
      const hide = !matchesSelection(entity.tagKeys, selection, mode)
      for (const el of entity.elements || []) {
        if (!el || !el.style) continue
        const want = hide ? 'none' : ''
        if (el.style.display !== want) el.style.display = want
        if (hide) touched.add(el)
        else touched.delete(el)
      }
    }
  }

  function restoreAll() {
    for (const el of touched) {
      try {
        if (el && el.style) el.style.display = ''
      } catch (error) {
        /* 元素可能已被移除，忽略 */
      }
    }
    touched.clear()
  }

  /** 当前停留在哪个视图（只用于文案与诊断） */
  function describeView() {
    if (typeof document === 'undefined') return ''
    try {
      if (document.querySelector('.marketplace-toolbar')) return 'marketplace'
    } catch (error) {
      /* 忽略 */
    }
    return 'installed'
  }

  /**
   * 重算 chip / 统计 / 过滤效果。
   * 所有要显示的数据都在这里落进 reactive，并且**只在真的变了的时候写**，
   * 这样 1s 的兜底轮询不会造成每秒一次重渲染。
   */
  function recompute() {
    const entities = currentEntities()
    const stats = matchStats(entities, selection, mode)
    const chips = buildChips(entities, selection, mode, labels)
    const isLive = liveEntities.length > 0

    if (!sameChips(view.chips, chips)) view.chips = chips

    const sig = [
      chips.map((chip) => `${chip.key}:${chip.count}:${chip.alive}:${chip.selected ? 1 : 0}`).join(','),
      stats.total,
      stats.matched,
      stats.hidden,
      isLive ? 1 : 0,
      mode,
      selection.join('\u0001')
    ].join('\u0002')

    if (sig !== lastSig) {
      lastSig = sig
      view.selected = selection.slice()
      view.mode = mode
      view.total = stats.total
      view.matched = stats.matched
      view.hidden = stats.hidden
      view.tagCount = chips.filter((chip) => !chip.untagged).length
      view.untaggedCount = chips.reduce((n, chip) => n + (chip.untagged ? chip.count : 0), 0)
      view.noMatch = selection.length > 0 && stats.matched === 0
      view.source = isLive ? 'live' : 'snapshot'
      view.visible = stats.total > 0 && chips.length > 0
    }

    if (!sameChips(catalog.chips, chips)) catalog.chips = chips
    catalog.total = stats.total
    catalog.chipCount = chips.length
    catalog.fromSnapshot = !isLive
    catalog.source = isLive ? describeView() : snapshot.source
    catalog.at = isLive ? Date.now() : snapshot.at

    applyFilter()
  }

  /* ---------- 注入 / 卸载筛选条 ---------- */

  function dropHost(container) {
    const entry = hosts.get(container)
    if (!entry) return
    hosts.delete(container)
    if (typeof entry.dispose === 'function') {
      try {
        entry.dispose()
      } catch (error) {
        log('卸载筛选条失败', error)
      }
    }
    try {
      if (entry.host && entry.host.parentNode) entry.host.parentNode.removeChild(entry.host)
    } catch (error) {
      log('移除筛选条容器失败', error)
    }
  }

  function dropAllHosts() {
    for (const container of Array.from(hosts.keys())) dropHost(container)
  }

  /**
   * 让「一个宿主内容容器 = 一条筛选条」。
   *
   * 位置选在**卡片网格正上方**：两种视图的网格都在标题行之下，
   * 这样「已安装」与「在线插件」的观感完全一致；容器里没有可用网格
   * （空状态、骨架屏）时不注入，避免在没东西可筛的时候还占一行。
   */
  function syncHosts() {
    if (!settings.enableFilterBar || typeof document === 'undefined') {
      dropAllHosts()
      return
    }

    const keep = new Set()
    for (const grid of Array.from(document.querySelectorAll(DOM.grid))) {
      if (isBusyGrid(grid)) continue
      if (typeof grid.querySelector !== 'function' || !grid.querySelector(DOM.card)) continue
      const container = grid.parentNode
      if (!container || keep.has(container)) continue
      keep.add(container)

      let entry = hosts.get(container)
      if (entry && (!entry.host || !entry.host.isConnected)) {
        dropHost(container)
        entry = null
      }

      if (!entry) {
        let host = null
        try {
          host = document.createElement('div')
          host.className = 'etf-host'
          host.setAttribute('data-etf-host', '1')
          container.insertBefore(host, grid)
          let dispose = null
          try {
            dispose = ctx.ui.mount(host, TagFilterBar)
          } catch (error) {
            log('挂载筛选条失败', error)
          }
          hosts.set(container, { host, dispose: typeof dispose === 'function' ? dispose : null })
          log('已注入筛选条')
        } catch (error) {
          log('注入筛选条容器失败', error)
          try {
            if (host && host.parentNode) host.parentNode.removeChild(host)
          } catch (inner) {
            /* 忽略 */
          }
        }
      } else if (entry.host.nextSibling !== grid) {
        // 网格被宿主换成了新元素，把筛选条挪回它上面
        try {
          container.insertBefore(entry.host, grid)
        } catch (error) {
          log('调整筛选条位置失败', error)
        }
      }
    }

    for (const container of Array.from(hosts.keys())) {
      if (!keep.has(container) || !container.isConnected) dropHost(container)
    }
  }

  /* ---------- 主循环 ---------- */

  function sync() {
    if (disposed) return

    if (!settings.enableFilterBar) {
      // 关掉筛选条时不能只是不注入：已经隐藏的卡片必须还原
      dropAllHosts()
      liveEntities = []
      restoreAll()
      recompute()
      return
    }

    liveEntities = scanLive()
    rememberLabels(liveEntities)
    syncHosts()

    // 实时数据有变化时刷新快照（供「标签筛选」独立页面做标签总览）
    if (liveEntities.length > 0) {
      const items = buildSnapshotItems(liveEntities)
      const fingerprint = items.map((item) => `${item.id}|${item.tags.join(',')}`).join(';')
      if (fingerprint !== snapshot.fingerprint) {
        // snapshot.items 换新数组即触发快照实体重建，不需要在这里手动同步
        snapshot = { at: Date.now(), source: describeView(), items, fingerprint }
        scheduleSave()
      }
    }
    recompute()
  }

  function scheduleSync() {
    if (disposed || syncTimer) return
    syncTimer = setTimeout(() => {
      syncTimer = null
      try {
        sync()
      } catch (error) {
        log('同步失败', error)
      }
    }, SYNC_DEBOUNCE_MS)
  }

  function startWatching() {
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.body) {
      observer = new MutationObserver(scheduleSync)
      try {
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [BUSY_ATTR]
        })
      } catch (error) {
        log('启动 DOM 监听失败', error)
      }
    }
    pollTimer = setInterval(() => {
      try {
        sync()
      } catch (error) {
        log('轮询同步失败', error)
      }
    }, POLL_MS)
  }

  /* ---------- 交互 ---------- */

  function toggleTag(key) {
    if (!key) return
    if (selection.includes(key)) selection = selection.filter((item) => item !== key)
    else selection = selection.concat(key)
    recompute()
    scheduleSave()
    log('筛选变化', selection)
  }

  function clearSelection() {
    if (!selection.length) return
    selection = []
    recompute()
    scheduleSave()
    log('已清除筛选')
  }

  function setMode(next) {
    if (!MATCH_MODES[next] || next === mode) return
    mode = next
    recompute()
    scheduleSave()
  }

  function focusBar() {
    if (typeof document === 'undefined') return false
    const host = document.querySelector('.etf-host')
    if (!host) {
      toast('info', '请先打开「设置 → 插件」页面，筛选条在插件列表上方')
      return false
    }
    if (host.scrollIntoView) {
      try {
        host.scrollIntoView({ block: 'center', behavior: 'smooth' })
      } catch (error) {
        /* 老内核忽略参数即可 */
      }
    }
    view.barFocused = true
    setTimeout(() => {
      view.barFocused = false
    }, 1600)
    return true
  }

  /* ---------- 界面片段 ---------- */

  const icon = (path, size) =>
    h(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: size || 15,
        height: size || 15,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        style: 'flex-shrink:0'
      },
      [h('path', { d: path })]
    )

  const ICON_FILTER = 'M3 5h18 M6 12h12 M10 19h4'
  const ICON_CLEAR = 'M18 6 6 18 M6 6l12 12'
  const ICON_SEARCH = 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4'
  const ICON_LAYERS = 'M12 3 3 8l9 5 9-5-9-5z M3 16l9 5 9-5 M3 12l9 5 9-5'

  function chipTitle(chip) {
    const kind = chip.capability ? '能力标签' : chip.untagged ? '没有任何标签的插件' : '标签'
    if (chip.dead) return `${kind}：在当前筛选条件下没有插件带这个标签`
    if (chip.selected) return `${kind}：当前共 ${chip.alive} 个插件匹配；点击取消选择`
    return `${kind}：选中后共 ${chip.alive} 个插件匹配`
  }

  function renderChip(chip, extraClass) {
    const classes = ['etf-chip']
    if (extraClass) classes.push(extraClass)
    if (chip.selected) classes.push('is-on')
    if (chip.dead) classes.push('is-dead')
    if (chip.capability) classes.push('is-cap')
    if (chip.untagged) classes.push('is-untagged')
    return h(
      'button',
      {
        key: chip.key,
        class: classes.join(' '),
        type: 'button',
        title: chipTitle(chip),
        'aria-pressed': chip.selected ? 'true' : 'false',
        'data-tag': chip.untagged ? '__untagged__' : chip.key,
        'data-count': String(chip.count),
        'data-selected': chip.selected ? '1' : '0',
        'data-capability': chip.capability ? '1' : '0',
        onClick: () => toggleTag(chip.key)
      },
      [
        h('span', { class: 'etf-chip-label' }, chip.label),
        settings.showCounts ? h('span', { class: 'etf-chip-count' }, String(chip.count)) : null
      ]
    )
  }

  function renderModeSwitch() {
    const current = view.mode
    return h(
      'div',
      { class: 'etf-seg', role: 'group', 'aria-label': '匹配方式' },
      Object.values(MATCH_MODES).map((item) =>
        h(
          'button',
          {
            key: item.id,
            class: `etf-seg-btn${current === item.id ? ' is-on' : ''}`,
            type: 'button',
            title: item.title,
            'aria-pressed': current === item.id ? 'true' : 'false',
            'data-mode': item.id,
            onClick: () => setMode(item.id)
          },
          item.label
        )
      )
    )
  }

  function renderClearButton(extraClass, label) {
    return h(
      'button',
      {
        class: `etf-clear${extraClass ? ' ' + extraClass : ''}`,
        type: 'button',
        disabled: view.selected.length === 0,
        'data-action': 'clear',
        onClick: () => clearSelection()
      },
      [icon(ICON_CLEAR, 12), h('span', {}, label || '清除筛选')]
    )
  }

  function renderEmptyState() {
    const selectedLabels = view.chips.filter((chip) => chip.selected).map((chip) => chip.label)
    const detail = selectedLabels.length
      ? `已选标签：${selectedLabels.join('、')}`
      : '当前没有插件符合所选标签'
    return h('div', { class: 'etf-empty', 'data-role': 'empty' }, [
      h('span', { class: 'etf-empty-icon' }, [icon(ICON_SEARCH, 20)]),
      h('p', { class: 'etf-empty-title' }, '没有符合标签的插件'),
      h('p', { class: 'etf-empty-desc' }, `${detail}。试试少选几个标签，或清除筛选回到完整列表。`),
      h(
        'button',
        {
          class: 'etf-empty-btn',
          type: 'button',
          'data-action': 'clear',
          onClick: () => clearSelection()
        },
        '清除筛选'
      )
    ])
  }

  function renderStatus() {
    const pieces = []
    if (!view.selected.length) {
      pieces.push(`共 ${view.total} 个插件`)
      pieces.push(`${view.tagCount} 个标签`)
      if (view.untaggedCount > 0) pieces.push(`${view.untaggedCount} 个未标注`)
      if (view.source === 'snapshot') pieces.push('上次采集')
    } else {
      pieces.push(`显示 ${view.matched} / ${view.total}`)
      pieces.push(`已选 ${view.selected.length} 个标签`)
      if (view.hidden > 0) pieces.push(`隐藏 ${view.hidden} 个`)
    }
    return h('div', { class: 'etf-status', 'data-role': 'status' }, pieces.join(' · '))
  }

  /**
   * 降级提示：宿主没给出任何标签（例如所有插件都是手工放进插件目录的本地安装，
   * 没有 plugins:catalog-tags 记录）。这种情况下筛选条只剩「未标注」，得说清楚。
   */
  function renderHint() {
    if (view.tagCount > 0 || view.total === 0) return null
    return h(
      'div',
      { class: 'etf-hint', 'data-role': 'hint' },
      '宿主没有提供任何插件标签：目前只能按「未标注」筛选。从「在线插件」安装过的插件会带有索引里的标签。'
    )
  }

  const TagFilterBar = defineComponent({
    name: 'TagFilterBar',
    setup() {
      return () => {
        if (!view.visible || !settings.enableFilterBar) return null
        return h('div', { class: `etf-bar${view.barFocused ? ' is-focused' : ''}` }, [
          h('div', { class: 'etf-bar-head' }, [
            h('span', { class: 'etf-bar-title' }, [icon(ICON_FILTER, 13), h('span', {}, '按标签筛选')]),
            h(
              'div',
              { class: 'etf-chips', role: 'group', 'aria-label': '插件标签' },
              view.chips.map((chip) => renderChip(chip))
            ),
            h('div', { class: 'etf-bar-tools' }, [renderModeSwitch(), renderClearButton()])
          ]),
          renderStatus(),
          view.noMatch ? renderEmptyState() : renderHint()
        ])
      }
    }
  })

  /* ---------- 独立页面：标签总览 + 状态 ---------- */

  function formatTime(ts) {
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return '未知时间'
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  const VIEW_LABELS = { marketplace: '在线插件视图', installed: '已安装视图' }

  function catalogMetaText() {
    if (!catalog.total) return '暂无数据'
    const where = VIEW_LABELS[catalog.source] || '插件面板'
    if (catalog.fromSnapshot) {
      return `上次采集：${catalog.at ? formatTime(catalog.at) : '未知时间'} · ${where} · ${catalog.total} 个插件`
    }
    return `实时：${where} · ${catalog.total} 个插件`
  }

  function kv(label, value) {
    return h('div', { class: 'etf-kv-row', key: label }, [
      h('span', { class: 'etf-kv-key' }, label),
      h('span', { class: 'etf-kv-val' }, value)
    ])
  }

  const TagFilterPage = defineComponent({
    name: 'TagFilterPage',
    setup() {
      const refresh = () => {
        sync()
        if (!liveEntities.length) {
          toast('info', '请先打开「设置 → 插件」页面，插件会自动采集标签')
        } else {
          toast('success', `已采集：${liveEntities.length} 个插件 / ${catalog.chipCount} 个标签`)
        }
      }

      const copyDiagnostics = async () => {
        const payload = buildDiagnostics()
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(payload)
            toast('success', '诊断信息已复制')
          } else {
            log(payload)
            toast('warning', '当前环境不支持剪贴板，诊断信息已输出到控制台')
          }
        } catch (error) {
          log('复制诊断失败', error)
          toast('warning', '复制失败，诊断信息已输出到控制台')
        }
      }

      const b = (text, action, onClick, iconPath) =>
        h('button', { class: 'etf-btn', type: 'button', 'data-action': action, onClick }, [
          icon(iconPath, 13),
          h('span', {}, text)
        ])

      return () =>
        h('div', { class: 'etf-page' }, [
          h('section', { class: 'etf-hero' }, [
            h('h2', { class: 'etf-hero-title' }, [icon(ICON_FILTER, 18), h('span', {}, '插件标签筛选')]),
            h(
              'p',
              { class: 'etf-hero-desc' },
              '打开「设置 → 插件」后，插件网格的上方会出现一条标签筛选条：点一个或多个标签即时过滤列表，' +
                '「清除筛选」恢复完整列表。下面这份标签总览与筛选条共享同一份选择。'
            ),
            h('div', { class: 'etf-hero-actions' }, [
              b('定位筛选条', 'locate', () => void focusBar(), ICON_SEARCH),
              b('重新采集', 'refresh', refresh, ICON_LAYERS),
              b('复制诊断', 'copy-diagnostics', () => void copyDiagnostics())
            ])
          ]),

          h('section', { class: 'etf-card' }, [
            h('div', { class: 'etf-card-head' }, [
              h('h3', { class: 'etf-card-title' }, '标签总览'),
              h('span', { class: 'etf-card-meta', 'data-role': 'catalog-meta' }, catalogMetaText())
            ]),
            catalog.chips.length
              ? h(
                  'div',
                  { class: 'etf-page-chips' },
                  catalog.chips.map((chip) => renderChip(chip, 'etf-chip-lg'))
                )
              : h(
                  'p',
                  { class: 'etf-page-empty', 'data-role': 'catalog-empty' },
                  '还没有采集到标签。请先打开「设置 → 插件」页面。'
                ),
            h('div', { class: 'etf-page-tools' }, [
              renderModeSwitch(),
              renderClearButton('etf-clear-lg', '清除筛选')
            ])
          ]),

          h('section', { class: 'etf-card' }, [
            h('h3', { class: 'etf-card-title' }, '当前状态'),
            h('div', { class: 'etf-kv' }, [
              kv('面板筛选条', settings.enableFilterBar ? '已开启' : '已关闭'),
              kv('数据来源', view.source === 'live' ? '实时读取插件面板' : '上次采集的快照'),
              kv('插件数量', String(view.total)),
              kv('标签数量', `${view.tagCount}${view.untaggedCount ? ` + ${view.untaggedCount} 个未标注` : ''}`),
              kv(
                '已选标签',
                view.selected.length
                  ? view.selected.map((key) => labels.get(key) || key).join('、')
                  : '无'
              ),
              kv('匹配方式', MATCH_MODES[view.mode] ? MATCH_MODES[view.mode].label : view.mode)
            ])
          ])
        ])
    }
  })

  /* ---------- 设置面板 ---------- */

  function renderToggle(checked, onToggle, title) {
    const on = !!checked
    const fire = (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      onToggle(!on)
    }
    return h(
      'span',
      {
        class: 'etf-switch',
        role: 'switch',
        tabindex: '0',
        'aria-checked': on ? 'true' : 'false',
        'data-on': on ? 'true' : 'false',
        title: title || (on ? '点击关闭' : '点击开启'),
        onClick: fire,
        onKeydown: (event) => {
          if (event && (event.key === 'Enter' || event.key === ' ')) fire(event)
        }
      },
      [h('span', { class: 'etf-switch-knob' })]
    )
  }

  function renderSwitchRow(title, desc, checked, onChange, hook) {
    const on = !!checked
    return h('div', { class: `etf-switch-row${on ? ' is-on' : ''}` }, [
      h('div', { class: 'etf-switch-text' }, [
        h('div', { class: 'etf-switch-title' }, [
          h('span', {}, title),
          h('span', { class: `etf-state-chip${on ? ' is-on' : ''}` }, on ? '已开启' : '已关闭')
        ]),
        h('div', { class: 'etf-switch-desc' }, desc)
      ]),
      renderToggle(on, onChange, hook ? '' : undefined)
    ])
  }

  const SettingsPanel = defineComponent({
    name: 'TagFilterSettings',
    setup() {
      const save = (key, value) => void updateSetting(key, value)
      return () =>
        h('div', { class: 'etf-settings' }, [
          renderSwitchRow(
            '在插件面板显示标签筛选条',
            '在「设置 → 插件」页面的插件网格上方注入筛选条；关闭后不再过滤，卡片立即恢复完整列表',
            settings.enableFilterBar,
            (value) => save('enableFilterBar', value)
          ),
          renderSwitchRow(
            '侧边栏显示「标签筛选」入口',
            '关闭后只保留面板内的筛选条，侧边栏少一个入口（切换后立即生效）',
            settings.showSidebarEntry,
            (value) => save('showSidebarEntry', value)
          ),
          renderSwitchRow(
            '记住筛选状态',
            '把已选标签与匹配方式写进插件存储，重启主程序后恢复',
            settings.persistSelection,
            (value) => save('persistSelection', value)
          ),
          renderSwitchRow(
            '在标签上显示插件数量',
            '每个标签后面显示当前视图里带该标签的插件数',
            settings.showCounts,
            (value) => save('showCounts', value)
          ),
          renderSwitchRow(
            '同时纳入「能力标签」',
            '除目录标签外，额外聚合由 manifest.capabilities 生成的能力标签（如「网络」「本地文件」）',
            settings.includeFeatureTags,
            (value) => save('includeFeatureTags', value)
          ),
          renderSwitchRow('调试日志', '在开发者控制台输出详细日志', settings.debug, (value) =>
            save('debug', value)
          ),
          h('div', { class: 'etf-field' }, [
            h('span', { class: 'etf-field-label' }, '默认匹配方式'),
            h(
              'div',
              { class: 'etf-seg etf-seg-lg', role: 'group' },
              Object.values(MATCH_MODES).map((item) =>
                h(
                  'button',
                  {
                    key: item.id,
                    class: `etf-seg-btn${settings.defaultMode === item.id ? ' is-on' : ''}`,
                    type: 'button',
                    title: item.title,
                    'data-default-mode': item.id,
                    onClick: () => save('defaultMode', item.id)
                  },
                  item.label
                )
              )
            )
          ])
        ])
    }
  })

  async function updateSetting(key, value) {
    settings[key] = value
    if (key === 'enableFilterBar' || key === 'includeFeatureTags') {
      sync()
    } else if (key === 'showSidebarEntry') {
      applySidebarEntry(value)
    } else if (key === 'defaultMode' && !selection.length) {
      mode = MATCH_MODES[value] ? value : DEFAULT_SETTINGS.defaultMode
      recompute()
    } else {
      recompute()
    }
    await persist()
  }

  /* ---------- 诊断 ---------- */

  function domSnapshot() {
    if (typeof document === 'undefined') return { available: false }
    const grids = Array.from(document.querySelectorAll(DOM.grid))
    const cards = Array.from(document.querySelectorAll(DOM.card))
    return {
      available: true,
      grids: grids.length,
      busyGrids: grids.filter(isBusyGrid).length,
      cards: cards.length,
      cardsWithId: cards.filter((card) => !!stripIdPrefix(textOf(cardQuery(card, DOM.cardId)))).length,
      cardsWithTags: cards.filter((card) => !!cardQuery(card, DOM.tags)).length,
      cardsWithFeatureTags: cards.filter((card) => !!cardQuery(card, DOM.featureTags)).length,
      contents: document.querySelectorAll(DOM.content).length,
      hosts: document.querySelectorAll('.etf-host').length,
      view: describeView()
    }
  }

  function buildDiagnostics() {
    return JSON.stringify(
      {
        plugin: 'tag-filter',
        at: new Date().toISOString(),
        settings: { ...settings },
        selection: selection.slice(),
        mode,
        dom: domSnapshot(),
        live: {
          entities: liveEntities.length,
          elements: liveEntities.reduce((n, entity) => n + (entity.elements ? entity.elements.length : 0), 0)
        },
        snapshot: { at: snapshot.at, source: snapshot.source, items: snapshotEntities().length },
        cards: liveEntities.slice(0, 80).map((entity) => ({
          id: entity.id,
          name: entity.name,
          tags: entity.tags.map((tag) => tag.label),
          elements: entity.elements ? entity.elements.length : 0,
          hidden: !matchesSelection(entity.tagKeys, selection, mode)
        }))
      },
      null,
      2
    )
  }

  /* ---------- 侧边栏入口 ---------- */

  let sidebarDispose = null

  function applySidebarEntry(enabled) {
    if (enabled) {
      if (sidebarDispose) return true
      try {
        const dispose =
          ctx.ui && ctx.ui.sidebar && typeof ctx.ui.sidebar.addItem === 'function'
            ? ctx.ui.sidebar.addItem({
                id: 'tag-filter-entry',
                title: '标签筛选',
                icon: 'tabler:filter',
                pageId: 'tag-filter',
                section: 'plugins',
                sectionTitle: '插件',
                order: 40
              })
            : null
        sidebarDispose = typeof dispose === 'function' ? dispose : () => {}
        log('侧边栏入口已注册')
        return true
      } catch (error) {
        log('注册侧边栏入口失败', error)
        sidebarDispose = null
        return false
      }
    }

    if (typeof sidebarDispose === 'function') {
      try {
        sidebarDispose()
      } catch (error) {
        log('移除侧边栏入口失败', error)
      }
    }
    sidebarDispose = null
    return true
  }

  /* ---------- 启动 ---------- */

  try {
    applyLoaded(await ctx.storage.get(STORAGE_KEY))
  } catch (error) {
    log('读取配置失败，使用默认值', error)
    applyLoaded(null)
  }

  ctx.ui.addPage({
    id: 'tag-filter',
    title: '标签筛选',
    icon: 'tabler:filter',
    component: TagFilterPage
  })

  applySidebarEntry(settings.showSidebarEntry)

  ctx.ui.settings.define({
    title: '插件标签筛选 设置',
    description: '筛选条的显示、匹配方式与标签来源。',
    component: SettingsPanel
  })

  ctx.commands.register('clear-tag-filter', () => {
    if (!selection.length) {
      toast('info', '当前没有标签筛选条件')
      return
    }
    clearSelection()
    toast('success', '已清除标签筛选')
  })
  ctx.commands.register('toggle-tag-filter-bar', async () => {
    await updateSetting('enableFilterBar', !settings.enableFilterBar)
    toast('success', settings.enableFilterBar ? '已开启标签筛选条' : '已关闭标签筛选条')
  })

  startWatching()
  sync()

  ctx.dispose(() => {
    disposed = true
    if (observer) {
      try {
        observer.disconnect()
      } catch (error) {
        log('停止 DOM 监听失败', error)
      }
      observer = null
    }
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = null
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    dropAllHosts()
    restoreAll()
    if (typeof sidebarDispose === 'function') sidebarDispose()
    sidebarDispose = null
  })

  log('已启用')
}

export async function deactivate() {
  // 页面、设置面板、命令、注入的样式由宿主统一回收；
  // 被隐藏的卡片在 ctx.dispose 回调里已经还原，这里无需额外处理。
}
