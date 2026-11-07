<script lang="ts">
import { onMount, tick } from "svelte";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  Command,
  Copy,
  Folder,
  Grid2X2,
  Minus,
  Monitor,
  Moon,
  Package,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  Terminal,
  Wrench,
  X,
} from "@lucide/svelte";
import DotWord from "./DotWord.svelte";
import ChatPanel from "./ChatPanel.svelte";
import Sidebar from "./Sidebar.svelte";
import Skills from "./Skills.svelte";
import Preferences from "./Preferences.svelte";
import { translations } from "./ui";
const icons: Record<string, any> = {
  package: Package,
  sliders: SlidersHorizontal,
  terminal: Terminal,
  radio: Radio,
  wrench: Wrench,
  sparkles: Sparkles,
};
let lang = localStorage.getItem("localdesk-language-v2") || "en";
let theme = localStorage.getItem("localdesk-theme") || "system";
let font = localStorage.getItem("localdesk-font") || "system";
let data: any = null,
  error = "",
  query = "",
  view = ["activity", "modules", "skills"].includes(
      new URLSearchParams(location.search).get("view") || "",
    )
    ? new URLSearchParams(location.search).get("view")!
    : "overview",
  activeModule: any = null,
  itemQuery = "",
  preferences = false,
  selectedJob: any = null;
let draft = "",
  sending = false,
  context = "",
  responseMs = 0,
  clock = new Date(),
  copied = false,
  textarea: HTMLTextAreaElement;
let activeChatId = new URLSearchParams(location.search).get("chat") ||
  localStorage.getItem("localdesk-chat") || "";
let chatTurns: any[] = [], chatSignature = "";
let chatActionId = "";
let chosenPreset = localStorage.getItem("localdesk-preset") || "";
let chosenEffort = localStorage.getItem("localdesk-effort") || "";
let fast = localStorage.getItem("localdesk-fast") === "true";
let draftCache: Record<string, { draft: string; context: string }> = {};
try {
  draftCache = JSON.parse(localStorage.getItem("localdesk-drafts-v1") || "{}");
} catch {}
({ draft, context } = draftCache[activeChatId] || { draft: "", context: "" });
$: {
  draftCache[activeChatId] = { draft, context };
  localStorage.setItem("localdesk-drafts-v1", JSON.stringify(draftCache));
}
$: chat = data?.chats?.find((c: any) => c.id === activeChatId);
$: activeWorkspace = chat?.workspace || data?.workspace ||
  "";
$: sourceAvailable = data?.integrations?.find((s: any) => s.id === (activeWorkspace === data?.workspace ? "workspace" : "projects"))?.connected !== false;
$: chosen = data?.runner?.presets?.find((p: any) => p.name === chosenPreset);
$: {
  localStorage.setItem("localdesk-preset", chosenPreset);
  localStorage.setItem("localdesk-effort", chosenEffort);
  localStorage.setItem("localdesk-fast", String(fast));
}
$: localStorage.setItem("localdesk-chat", activeChatId);
let pendingId: string | null = null, pendingPrompt = "";
$: dict = translations[lang] ?? translations.en;
$: t = (key: string) => dict[key] ?? key;
$: plugins = data?.catalog?.plugins ?? [];
$: enabled = plugins.filter((p: any) => p.enabled);
$: total = plugins.reduce((n: number, p: any) => n + p.items.length, 0);
$: cards = enabled.map((p: any) => ({
  ...p,
  matching: !query.trim()
    ? p.items
    : p.items.filter((i: any) =>
      (i.name + " " + i.path).toLowerCase().includes(query.toLowerCase()) ||
      title(p).toLowerCase().includes(query.toLowerCase())
    ),
})).filter((p: any) => !query || p.matching.length);
$: activeCount =
  (data?.jobs ?? []).filter((j: any) => ["queued", "running"].includes(j.state))
    .length;
$: current = (data?.jobs ?? []).find((j: any) => j.state === "running");
$: moduleItems = activeModule
  ? (plugins.find((p: any) => p.id === activeModule.id)?.items ?? []).filter((
    i: any,
  ) => (i.name + " " + i.path).toLowerCase().includes(itemQuery.toLowerCase()))
  : [];
$: {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("localdesk-theme", theme);
}
$: {
  document.documentElement.dataset.font = font;
  localStorage.setItem("localdesk-font", font);
}
$: {
  document.documentElement.lang = lang;
  localStorage.setItem("localdesk-language-v2", lang);
}
$: title = (p: any) => p.title?.[lang] ?? p.title?.en ?? p.id;
function date(value: string) {
  return value
    ? new Date(value).toLocaleString(lang, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "—";
}
function kind(k: string) {
  return t(
    ({
      brew: "package",
      directory: "directory",
      link: "link",
      source: "sourceFile",
      cask: "cask",
      tap: "tap",
      mas: "mas",
    } as Record<string, string>)[k] ?? k,
  );
}
async function api(path: string, body?: unknown) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error ?? `${r.status}`);
  return v;
}
async function load() {
  try {
    const start = performance.now();
    data = await api("/api/state");
    if (!chosenPreset && data.runner?.presets?.length) {
      chosenPreset = data.runner.presets.some((preset: any) => preset.name === data.runner.name)
        ? data.runner.name : data.runner.presets[0].name;
      applyPreset();
    }
    if (data.catalog.connected === false) activeModule = null;
    const moduleId = new URLSearchParams(location.search).get("module");
    if (moduleId) {
      if(moduleId === "skills") view = "skills";
      else activeModule = data.catalog.plugins.find((p: any) => p.id === moduleId);
      history.replaceState(null, "", moduleId === "skills" ? "/?view=skills" : "/?view=overview");
    }
    responseMs = performance.now() - start;
    if (selectedJob) selectedJob = await api("/api/jobs/" + selectedJob.id);
    if (
      data.ready && activeChatId &&
      !data.chats.some((c: any) => c.id === activeChatId)
    ) {
      activeChatId = "";
    }
    if (view === "activity") await loadChat();
  } catch (e) {
    error = String(e);
  }
}
async function refresh() {
  try {
    await api("/api/refresh", {});
    await load();
  } catch (e) {
    error = String(e);
  }
}
async function toggle(p: any) {
  try {
    await api("/api/modules", { id: p.id, enabled: !p.enabled });
    await load();
  } catch (e) {
    error = String(e);
  }
}
async function showJob(j: any) {
  try {
    selectedJob = await api("/api/jobs/" + j.id);
  } catch (e) {
    error = String(e);
  }
}
async function loadChat() {
  if (!data?.ready) return;
  const id = activeChatId;
  const signature = id +
    JSON.stringify(
      (data?.jobs ?? []).filter((j: any) => j.chatId === id).map((
        j: any,
      ) => [j.id, j.state, j.eventCount]),
    );
  if (!id) {
    chatTurns = [];
    chatSignature = "";
    return;
  }
  if (signature === chatSignature) return;
  const result = await api("/api/chats/" + id);
  if (activeChatId === id) {
    chatTurns = result.turns;
    chatSignature = signature;
  }
}
function applyPreset() {
  const p = data?.runner?.presets.find((p: any) => p.name === chosenPreset);
  if (p) {
    chosenEffort = p.effort;
    fast = p.tier === "priority";
  }
}
async function chooseChat(id: string) {
  draftCache[activeChatId] = { draft, context };
  activeChatId = id;
  chatSignature = "";
  chatTurns = [];
  ({ draft, context } = draftCache[id] ?? { draft: "", context: "" });
  const c = data?.chats.find((c: any) => c.id === id);
  if (c?.execution) {
    chosenPreset = c.execution.preset;
    chosenEffort = c.execution.effort;
    fast = c.execution.fast;
  }
  view = "activity";
  await loadChat();
  await tick();
  textarea?.focus();
}
async function newChat(workspace = activeWorkspace) {
  try {
    const c = await api("/api/chats", { id: crypto.randomUUID(), workspace });
    await load();
    await chooseChat(c.id);
  } catch (e) {
    error = String(e);
  }
}
async function archiveChat(c: any, archived: boolean) {
  error = "";
  if (chatActionId) return;
  chatActionId = c.id;
  try {
    await api("/api/chats/" + c.id, { archived });
    await load();
  } catch (e) {
    error = String(e);
  } finally {
    chatActionId = "";
  }
}
async function submit() {
  if (
    !draft.trim() || sending || !data?.canControl || chat?.archived || !chosen
  ) return;
  sending = true;
  error = "";
  const prompt = (context ? `${t("context")}: ${context}\n\n` : "") +
    draft.trim();
  const execution = { preset: chosenPreset, effort: chosenEffort, fast };
  const key = JSON.stringify([
    prompt,
    execution,
    activeChatId,
    activeWorkspace,
  ]);
  if (key !== pendingPrompt || !pendingId) {
    pendingId = crypto.randomUUID();
    pendingPrompt = key;
  }
  try {
    const j = await api("/api/jobs", {
      id: pendingId,
      prompt,
      execution,
      workspace: activeWorkspace,
      ...(activeChatId ? { chatId: activeChatId } : {}),
    });
    pendingId = null;
    draft = "";
    context = "";
    draftCache[activeChatId] = { draft: "", context: "" };
    activeChatId = j.chatId;
    selectedJob = null;
    view = "activity";
    chatSignature = "";
    await load();
    await tick();
    textarea?.focus();
  } catch (e) {
    error = String(e);
  } finally {
    sending = false;
  }
}
async function stop(j: any) {
  try {
    await api("/api/jobs/" + j.id + "/cancel", {});
    await load();
  } catch (e) {
    error = String(e);
  }
}
async function inspect(item: any) {
  if (activeWorkspace !== data.workspace) await newChat(data.workspace);
  context = data.workspace + "/" + item.path;
  activeModule = null;
  draft = t("quickInspect") + item.name;
  await tick();
  textarea?.focus();
}
async function continueJob(j: any) {
  selectedJob = null;
  await chooseChat(j.chatId);
}

function keys(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  }
}
function trap(node: HTMLElement) {
  const previous = document.activeElement as HTMLElement | null;
  node.focus();
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const choices = Array.from(
      node.querySelectorAll<HTMLElement>(
        "button:not(:disabled),input:not(:disabled),select,textarea:not(:disabled),summary,[href]",
      ),
    ).filter((el) => el.getClientRects().length);
    if (!choices.length) {
      e.preventDefault();
      return;
    }
    const first = choices[0], last = choices.at(-1)!;
    if (
      e.shiftKey &&
      (document.activeElement === first || document.activeElement === node)
    ) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  node.addEventListener("keydown", key);
  return {
    destroy() {
      node.removeEventListener("keydown", key);
      previous?.focus();
    },
  };
}
function globalKeys(e: KeyboardEvent) {
  if (e.key === "Escape") {
    activeModule = null;
    selectedJob = null;
    preferences = false;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    document.getElementById("catalog-search")?.focus();
  }
}
async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(data.workspace + "/" + path);
    copied = true;
    setTimeout(() => copied = false, 1200);
  } catch (e) {
    error = String(e);
  }
}
onMount(() => {
  void load();
  const timer = setInterval(() => {
    if (!document.hidden) void load();
  }, 3000);
  const tick = setInterval(() => clock = new Date(), 1000);
  return () => {
    clearInterval(timer);
    clearInterval(tick);
  };
});
</script>
<svelte:window onkeydown={globalKeys} />
<div class="shell">
  <Sidebar {lang} active={view} {plugins}
    onSource={(p)=>{if(p.id==='skills'){location.href='/?view=skills';}else{activeModule=p;itemQuery='';}}}
    onSettings={()=>preferences=true} />

  <main>
  <header class="topbar"><div><span class="breadcrumb">LOCALDESK · 0.2.1</span><span class="slash">/</span><span>{t(view)}</span></div><div class="header-right"><span class="connection"><i class:busy={activeCount>0}></i>{t('connected')}</span><button class="icon-button mobile-prefs" aria-label={t('settings')} onclick={()=>preferences=true}><Settings2 size={17}/></button><time>{clock.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</time><button class="icon-button" aria-label={t('refresh')} title={t('refresh')} onclick={refresh}><RefreshCw size={17} class={data?.catalog?.scanning?'spin':''}/></button></div></header>
  {#if error}<div class="error-banner" role="alert"><AlertCircle size={17}/><span>{error}</span><button aria-label={t('close')} onclick={()=>error=''}><X size={16}/></button></div>{/if}
  {#if view==='overview'}
   <section class="hero-row">
    <div class="hero"><div class="hero-copy"><span class="eyebrow">PERSONAL SYSTEM / 001</span><h1>{t('heroA')}<br/><span>{t('heroB')}</span></h1><p>{t('heroCaption')}</p></div><div class="hero-matrix" aria-hidden="true">{#each Array(144) as _,i}<i class:red={(i%12===5||i%12===6)&&i>35&&i<108} class:on={Math.hypot(i%12-5.5,Math.floor(i/12)-5.5)>3.5&&Math.hypot(i%12-5.5,Math.floor(i/12)-5.5)<5.8}></i>{/each}</div><span class="hero-corner">( L )</span></div>
    <div class="signal"><div class="signal-heading"><span class="eyebrow">{t('autoDiscover')}</span><span class="signal-dot"></span></div><div class="signal-value">{new Intl.NumberFormat(lang).format(total)}<span>↗</span></div><div class="signal-bottom"><span>{t('discovered')}</span><span>{enabled.length}/{plugins.length} {t('sources')}</span></div><div class="signal-track">{#each Array(36) as _,i}<i class:filled={i<Math.round(enabled.length/Math.max(plugins.length,1)*36)}></i>{/each}</div></div>
   </section>
   <div class="catalog-toolbar"><div class="section-name"><span>01</span><h2>{t('overview')}</h2><small>{t('sourceScope')}</small></div><label class="search"><Search size={15}/><input id="catalog-search" bind:value={query} placeholder={t('search')}/><kbd>⌘ K</kbd></label></div>
   <section class="card-board" style={`--card-count:${cards.length}`} aria-label={t('sources')}>
    {#each cards as p,index}{@const Icon=icons[p.icon]??Folder}<button class="module-card" onclick={()=>{if(p.id==='skills'){location.href='/?view=skills';}else{activeModule=p;itemQuery=query;}}}><div class="card-top"><span class="module-icon"><Icon size={22} strokeWidth={1.5}/></span><span class="card-number">/{String(index+1).padStart(2,'0')}</span><ArrowUpRight size={19}/></div><div class="card-title"><h3>{title(p)}</h3><span class="count">{query?p.matching.length:p.items.length}</span></div><div class="card-previews">{#each p.matching.slice(0,6) as item}<span><b>{item.name.replace(/\.(sh|nim|ts|json|yaml)$/,'')}</b><small>{kind(item.kind)}</small></span>{/each}</div><div class="card-footer"><code>{p.path}</code><span class:error={p.error}><i></i>{p.error?t('unavailable'):t('viewAll')}</span></div></button>{/each}
    {#if !cards.length}<div class="empty-board"><Search size={30}/><p>{data?.catalog?.connected===false?t('sourceOffline'):data?t('noMatch'):t('loading')}</p></div>{/if}
   </section>
  {:else if view==='skills'}
   {#if data?.catalog?.connected!==false}<Skills {lang} />{:else}<p class="muted-note">{t('sourceOffline')}</p>{/if}
  {:else if view==='modules'}
   <div class="page-heading"><span class="eyebrow">{t('moduleVisibility')}</span><h1>{t('moduleTitle')}</h1><p>{t('moduleCaption')}</p></div>
   <section class="module-settings">{#each plugins as p}{@const Icon=icons[p.icon]??Folder}<div class="setting-module"><Icon size={24}/><div><h3>{title(p)}</h3><code>{p.path}</code></div><span class="module-amount">{p.items.length} {t('items')}</span><button class="switch" class:enabled={p.enabled} role="switch" aria-checked={p.enabled} aria-label={title(p)} disabled={!data?.canControl||data?.catalog?.connected===false} onclick={()=>toggle(p)}><i></i></button></div>{/each}</section><p class="muted-note">{t('moduleHint')}</p>
  {:else}
   {#if !sourceAvailable}<p class="muted-note" role="status">{t('sourceOffline')}</p>{/if}
   <ChatPanel chats={data?.chats??[]} activeId={activeChatId} turns={chatTurns} {t} {date} onSelect={chooseChat} onNew={()=>newChat()} onArchive={archiveChat} onDetails={showJob} onStop={stop} actionId={chatActionId} canControl={!!data?.canControl&&sourceAvailable} workspace={activeWorkspace}/>
  {/if}
  <div class="status-line"><span><i></i>{data?t('online'):t('loading')}</span><span>{t('lastScan')} {date(data?.catalog?.scannedAt)}<b>·</b>{t('scanTime')} {Math.round(data?.catalog?.durationMs??0)} ms<b>·</b>{t('response')} {Math.round(responseMs)} ms</span>{#if data?.catalog?.errors?.length}<button onclick={()=>error=data.catalog.errors.join('\n')}>{t('scanError')}</button>{/if}</div>
  <section class="command-dock" aria-label={t('prompt')}>
   {#if context}<div class="context-chip"><span>{context}</span><button aria-label={t('clear')} onclick={()=>context=''}><X size={12}/></button></div>{/if}
   <div class="composer"><button class="command-mark new-chat-button" aria-label={t('newChat')} title={t('newChat')} onclick={()=>newChat()} disabled={!data?.canControl||!sourceAvailable}><Plus size={20}/></button><textarea bind:this={textarea} bind:value={draft} onkeydown={keys} rows="1" maxlength="11500" placeholder={data?.canControl?t('commandPlaceholder'):t('readOnly')} disabled={!data?.canControl||!sourceAvailable||chat?.archived} aria-label={t('prompt')}></textarea><button class="send" disabled={!draft.trim()||sending||!data?.runner?.ready||!data?.canControl||!sourceAvailable||chat?.archived||!chosen} onclick={submit} aria-label={t('send')}><ArrowUp size={20}/></button></div>
   <div class="composer-controls">
    <div class="session-control"><label for="chat-select">{t('chat')}</label><select id="chat-select" aria-label={t('chat')} value={activeChatId} onchange={(e)=>chooseChat(e.currentTarget.value)}><option value="">{t('newChat')}</option>{#each data?.chats??[] as c}<option value={c.id}>{c.archived?'↳ ':''}{c.title||t('newChat')}</option>{/each}</select></div>
    <div class="execution-controls"><label for="preset-select" class="sr-only">{t('preset')}</label><select id="preset-select" aria-label={t('preset')} bind:value={chosenPreset} onchange={applyPreset}>{#each data?.runner?.presets??[] as p}<option value={p.name}>{p.name.toUpperCase()}</option>{/each}</select><span class="control-separator">/</span><label for="effort-select" class="sr-only">{t('reasoning')}</label><select id="effort-select" aria-label={t('reasoning')} bind:value={chosenEffort}>{#each chosen?.efforts??[] as effort}<option value={effort}>{t('effort_'+effort)}</option>{/each}</select><button class="fast-toggle" class:enabled={fast} aria-pressed={fast} aria-label={t('fastMode')} title={t('fastHint')} disabled={!chosen?.fastAvailable} onclick={()=>fast=!fast}><span>ϟ</span> Fast <i></i></button></div>
   </div>
   <div class="workspace-target"><label for="workspace-target">{t("workspaceTarget")}</label><select id="workspace-target" aria-label={t("workspaceTarget")} value={activeWorkspace} onchange={(e)=>newChat(e.currentTarget.value)}>{#each data?.workspaces??[{name:t("workspace"),path:activeWorkspace}] as w}<option value={w.path}>{w.path===data?.workspace?t("workspaceName"):w.name} · {w.path}</option>{/each}</select></div>
   <div class="composer-footnote"><span><i class:running={activeCount>0}></i>{chat?.archived?t('archiveNote'):sending?t('sending'):activeCount?t('agentRunning'):!data?.runner?.ready?(data?.runner?.errorCode==='model_unconfigured'?t('modelUnconfigured'):data?.runner?.error||t('agentOffline')):t('modelOnline')}</span>{#if activeCount}<button onclick={()=>{view='activity';void loadChat();}}>{activeCount} {t('activeWork')}</button>{/if}</div>
  </section>
 </main>
</div>
{#if activeModule}
 <div class="scrim" role="presentation"
  onclick={(e)=>{if(e.target===e.currentTarget)activeModule=null;}}>
  <div class="drawer" use:trap role="dialog" aria-modal="true"
    aria-label={title(activeModule)}
    tabindex="-1"><div class="drawer-header"><div><span class="eyebrow">{t('source')} / {activeModule.path}</span><h2>{title(activeModule)} <small>{moduleItems.length}</small></h2></div><button class="icon-button" aria-label={t('close')} onclick={()=>activeModule=null}><X size={22}/></button></div><label class="drawer-search search"><Search size={17}/><input bind:value={itemQuery} placeholder={t('search')}/></label><div class="inventory"><div class="table-head"><span>{t('allItems')}</span><span>{t('kind')}</span></div>{#each moduleItems as item}<div class="inventory-row"><div><strong>{item.name}</strong><code>{item.path}</code></div><span class="type-badge">{kind(item.kind)}</span><button class="icon-button" title={t('copy')} aria-label={t('copy')+' '+item.name} onclick={()=>copyPath(item.path)}>{#if copied}<Check size={15}/>{:else}<Copy size={15}/>{/if}</button><button class="inspect-button" title={t('inspect')} aria-label={t('inspect')+' '+item.name} onclick={()=>inspect(item)}><ArrowUpRight size={18}/></button></div>{/each}{#if !moduleItems.length}<p class="muted-note">{t('noMatch')}</p>{/if}</div><div class="drawer-foot"><span>{t('sourceNote')}</span><code>{data?.workspace || ""}</code></div></div>
</div>
{/if}
{#if selectedJob}
 <div class="scrim" role="presentation"
  onclick={(e)=>{if(e.target===e.currentTarget)selectedJob=null;}}>
  <div class="drawer job-drawer" use:trap role="dialog" aria-modal="true"
    aria-label={t('jobDetail')} tabindex="-1">
    <div
      class="drawer-header"><div><span class="eyebrow">{t('jobDetail')} / {date(selectedJob.createdAt)}</span><h2>{t(selectedJob.state)} <span class="job-state-dot" class:working={selectedJob.state==='running'}></span></h2></div><button class="icon-button" aria-label={t('close')} onclick={()=>selectedJob=null}><X size={22}/></button></div>
    <div
      class="job-content"><div class="prompt-block"><span class="eyebrow">{t('prompt')}</span><p>{selectedJob.prompt}</p></div>{#if selectedJob.error}<div class="job-error">{selectedJob.error}</div>{/if}<div class="result-block"><h3>{t('result')}</h3><p>{selectedJob.result??t('pending')}</p></div><details class="event-details"><summary>{t('events')} ({selectedJob.events?.length??0})</summary>{#each selectedJob.events??[] as e}<div class="event"><span>{e.kind} / {date(e.at)}</span><pre>{e.text}</pre></div>{/each}</details></div>
    <div
      class="job-actions">{#if ['running','queued'].includes(selectedJob.state)}<span>{t('stopNote')}</span><button class="danger-button" onclick={()=>stop(selectedJob)}><Square size={14}/>{t('stop')}</button>{:else if selectedJob.threadId}<span>{selectedJob.model} · {selectedJob.effort} · {selectedJob.tier}</span><button class="primary-button" onclick={()=>continueJob(selectedJob)}>{t('continue')}<ArrowUpRight size={17}/></button>{/if}</div>
  </div>
</div>
{/if}
{#if preferences}<Preferences bind:lang bind:theme bind:font
  onSourcesChanged={load} onClose={()=>preferences=false} />{/if}
