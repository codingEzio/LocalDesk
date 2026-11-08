<script lang="ts">
import { onMount, tick } from "svelte";
import { fade } from "svelte/transition";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDot,
  Code2,
  Copy,
  Folder,
  GitBranch,
  Grid2X2,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  X,
  Zap,
} from "@lucide/svelte";
import DotWord from "./DotWord.svelte";
import Sidebar from "./Sidebar.svelte";
import Preferences from "./Preferences.svelte";
import { translations } from "./ui";
import { copy } from "./workbench-copy";
import "./workbench.css";
type Draft = {
  id: string;
  text: string;
  preset: string;
  effort: string;
  fast: boolean;
};
let lang = localStorage.getItem("localdesk-language-v2") || "en";
let theme = localStorage.getItem("localdesk-theme") || "system";
let font = localStorage.getItem("localdesk-font") || "system";
let data: any = null,
  runner: any = null,
  agentState: any = null,
  error = "",
  query = new URLSearchParams(location.search).get("q") || "",
  filter = "all",
  selectedName = localStorage.getItem("localdesk-workbench-project") || "";
let tab = "overview",
  drawer = false,
  refreshing = false,
  responseMs = 0,
  prepared = "",
  copied = false,
  reduced = false,
  mobile = false,
  preferences = false;
let board: HTMLElement,
  inspector: HTMLElement,
  lastCard: HTMLElement | null = null,
  width = 800,
  height = 550;
let sending = false,
  latestTurn: any = null,
  pendingSend: { id: string; key: string } | null = null;
let chatByProject: Record<string, string> = {};
try {
  chatByProject = JSON.parse(
    localStorage.getItem("localdesk-workbench-chats-v1") || "{}",
  );
} catch {}
$: currentChatId = chatByProject[selectedName] || "";
$: projectChats = (agentState?.chats || []).filter((c: any) =>
  c.workspace === selected?.path
);
$: currentChat = projectChats.find((c: any) => c.id === currentChatId);
$: {
  const url = new URL(location.href);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);
}
let drafts: Record<string, Draft[]> = {};
try {
  drafts = JSON.parse(localStorage.getItem("localdesk-workbench-drafts-v1") || "{}");
} catch { /* Preserve a usable preview if browser storage is invalid. */ }
let draftId = "",
  draft: Draft = {
    id: "",
    text: "",
    preset: configuredPreset()?.name || "",
    effort: configuredPreset()?.effort || "",
    fast: configuredPreset()?.tier === "priority",
  };
$: t = (key: string) =>
  (copy as any)[lang]?.[key] ?? copy.en[key as keyof typeof copy.en] ?? key;
$: projects = data?.snapshot?.projects ?? [];
$: if (data?.connected === false) { selectedName = ""; drawer = false; }
$: if (agentState?.readOnly && (filter === "web" || filter === "native")) filter = "all";
$: selected = projects.find((p: any) => p.name === selectedName);
$: matches = projects.filter((p: any) =>
  query.toLowerCase().trim().split(/\s+/).filter(Boolean).every((token) =>
    [
      p.name,
      p.path,
      p.branch,
      p.runtime?.ports?.frontend,
      p.runtime?.ports?.backend,
    ].join(" ").toLowerCase().includes(token)
  ) &&
  (filter === "all" ||
    (filter === "changed" ? p.is_dirty : p.runtime?.kind === filter))
);
$: dirty = projects.filter((p: any) => p.is_dirty).length;
$: columns = width < 500 ? 2 : Math.max(
  2,
  Math.min(
    6,
    Math.ceil(
      Math.sqrt(
        Math.max(1, matches.length) * width / Math.max(1, height) / 2.25,
      ),
    ),
  ),
);
$: rows = Math.max(1, Math.ceil(matches.length / columns));
$: tight = height / rows < 70;
$: options = runner?.presets ?? [];
$: chosen = options.find((p: any) => p.name === draft.preset);
$: localStorage.setItem("localdesk-workbench-project", selectedName);
$: {
  document.documentElement.lang = lang;
  localStorage.setItem("localdesk-language-v2", lang);
}
$: {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("localdesk-theme", theme);
}
$: {
  document.documentElement.dataset.font = font;
  localStorage.setItem("localdesk-font", font);
}
$: number = (n: any) => n == null ? "—" : Number(n).toLocaleString(lang);
$: time = (value: string) =>
  value
    ? new Date(value).toLocaleTimeString(lang, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    : "—";
$: state = (s: string) => t(s || "unknown");
$: changed = (p: any) => {
  if (!p.is_git) return t("noGit");
  if (p.is_dirty) {
    return `${number(p.changed_count)} ${t("changes")}${
      p.ahead_count > 0 ? ` · ↑${p.ahead_count}` : ""
    }`;
  }
  if (p.ahead_count > 0 && p.behind_count > 0) return t("diverged");
  if (p.ahead_count > 0) return `↑${number(p.ahead_count)} ${t("ahead")}`;
  if (p.behind_count > 0) return `↓${number(p.behind_count)} ${t("behind")}`;
  if (!p.has_remote) return t("local");
  if (!p.upstream) return t("upstreamNone");
  if ([p.changed_count, p.ahead_count, p.behind_count].some((x) => x == null)) {
    return t("unknown");
  }
  return t("clean");
};

function link(port: number) {
  return `${location.protocol}//${location.hostname}:${port}/`;
}
async function call(path: string, body?: unknown) {
  const response = await fetch(
    path,
    body === undefined ? undefined : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || String(response.status));
  return result;
}
function configuredPreset() {
  return runner?.presets?.find((preset: any) => preset.name === runner?.name) ||
    runner?.presets?.[0];
}
async function loadAgent() {
  try {
    const state = await call("/api/state");
    agentState = state;
    runner = state.runner;
    if (!draft.preset && runner?.presets?.length) {
      const preset = configuredPreset();
      draft = { ...draft, preset: preset.name, effort: preset.effort, fast: preset.tier === "priority" };
    }
    const id = chatByProject[selectedName];
    if (id && state.canControl) {
      const chat = await call("/api/chats/" + id);
      if (id === chatByProject[selectedName]) {
        latestTurn = chat.turns.at(-1) || null;
      }
    } else latestTurn = null;
  } catch (e) {
    error = String(e);
  }
}
function selectConversation(id: string) {
  chatByProject = { ...chatByProject, [selectedName]: id };
  localStorage.setItem("localdesk-workbench-chats-v1", JSON.stringify(chatByProject));
  latestTurn = null;
  prepared = "";
  void loadAgent();
}
async function sendInstruction() {
  if (
    sending || !draft.text.trim() || !agentState?.canControl || !chosen ||
    currentChat?.archived
  ) return;
  sending = true;
  error = "";
  const project = selected;
  const prompt = draft.text.trim();
  const execution = {
    preset: draft.preset,
    effort: draft.effort,
    fast: draft.fast,
  };
  try {
    saveDraft();
    let id = chatByProject[project.name];
    if (!id) {
      const created = await call("/api/chats", {
        id: draft.id,
        workspace: project.path,
      });
      id = created.id;
      chatByProject = { ...chatByProject, [project.name]: id };
      localStorage.setItem("localdesk-workbench-chats-v1", JSON.stringify(chatByProject));
    }
    const key = JSON.stringify([project.path, id, prompt, execution]);
    if (!pendingSend || pendingSend.key !== key) {
      pendingSend = { id: crypto.randomUUID(), key };
    }
    await call("/api/jobs", {
      id: pendingSend.id,
      prompt,
      chatId: id,
      workspace: project.path,
      execution,
    });
    pendingSend = null;
    if (selectedName === project.name) {
      newDraft();
      await loadAgent();
    }
  } catch (e) {
    error = String(e);
  } finally {
    sending = false;
  }
}
async function refreshProjects() {
  try {
    await call("/api/workbench/refresh", {});
    await load();
  } catch (e) {
    error = String(e);
  }
}
async function stopWork() {
  if (latestTurn) {
    await call("/api/jobs/" + latestTurn.id + "/cancel", {});
    await loadAgent();
  }
}
async function load() {
  if (refreshing) return;
  refreshing = true;
  try {
    const start = performance.now();
    const response = await fetch("/api/workbench");
    if (!response.ok) throw new Error(String(response.status));
    data = await response.json();
    const available = data?.snapshot?.projects ?? [];
    if (!available.some((project: any) => project.name === selectedName)) {
      selectedName = available[0]?.name || "";
      restoreDraft();
    }
    responseMs = Math.round(performance.now() - start);
    error = "";
  } catch (e) {
    error = String(e);
  } finally {
    refreshing = false;
  }
}
function persist() {
  drafts = {
    ...drafts,
    [selectedName]: (drafts[selectedName] || []).map((d) =>
      d.id === draft.id ? { ...draft } : d
    ),
  };
  localStorage.setItem("localdesk-workbench-drafts-v1", JSON.stringify(drafts));
  prepared = "";
}
function newDraft() {
  draft = {
    id: crypto.randomUUID(),
    text: "",
    preset: configuredPreset()?.name || "",
    effort: configuredPreset()?.effort || "",
    fast: configuredPreset()?.tier === "priority",
  };
  draftId = draft.id;
  drafts = {
    ...drafts,
    [selectedName]: [...(drafts[selectedName] || []), draft],
  };
  persist();
}
function restoreDraft(id?: string) {
  const list = drafts[selectedName] || [];
  const found = list.find((d) => d.id === id) || list.at(-1);
  if (found) {
    draft = { ...found };
    draftId = found.id;
  } else {
    draft = { id: "", text: "", preset: configuredPreset()?.name || "", effort: configuredPreset()?.effort || "", fast: configuredPreset()?.tier === "priority" };
    draftId = "";
  }
  prepared = "";
}
function saveDraft() {
  if (!draft.id) {
    draft = { ...draft, id: crypto.randomUUID() };
    draftId = draft.id;
    drafts = {
      ...drafts,
      [selectedName]: [...(drafts[selectedName] || []), draft],
    };
  }
  persist();
}
async function pick(p: any, event?: Event) {
  selectedName = p.name;
  latestTurn = null;
  void loadAgent();
  restoreDraft();
  drawer = true;
  if (event?.currentTarget instanceof HTMLElement) {
    lastCard = event.currentTarget;
  }
  await tick();
  if (mobile && drawer && inspector) {
    // Flush the drawer's visible style before moving keyboard focus into it.
    getComputedStyle(inspector).visibility;
    inspector.focus({ preventScroll: true });
  }
}
async function close() {
  drawer = false;
  await tick();
  lastCard?.focus({ preventScroll: true });
}
function presetChange() {
  const p = options.find((p: any) => p.name === draft.preset);
  if (p) {
    draft.effort = p.effort;
    draft.fast = p.tier === "priority";
    saveDraft();
  }
}
function suggestion(key: string) {
  draft.text = t(key + "Prompt");
  saveDraft();
  tab = "request";
}
function prepare() {
  if (!draft.text.trim()) return;
  saveDraft();
  prepared =
    `Project: ${selected.name}\nWorking directory: ${selected.path}\nSession: ${draft.id}\nModel: ${
      chosen?.model || draft.preset
    }\nReasoning: ${draft.effort}\nPriority: ${draft.fast}\n\n${draft.text.trim()}`;
}
async function copyRequest() {
  try {
    await navigator.clipboard.writeText(prepared);
    copied = true;
    setTimeout(() => copied = false, 1400);
  } catch (e) {
    error = String(e);
  }
}
function keys(e: KeyboardEvent) {
  if (preferences) return;
  if (e.key === "Escape") close();
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    document.getElementById("workbench-search")?.focus();
  }
  if (
    e.key === "Tab" && drawer && matchMedia("(max-width: 900px)").matches &&
    inspector
  ) {
    const list = [
      ...inspector.querySelectorAll<HTMLElement>(
        "button:not(:disabled),a,select,textarea",
      ),
    ].filter((el) => el.getClientRects().length);
    if (
      e.shiftKey &&
      (document.activeElement === list[0] ||
        document.activeElement === inspector)
    ) {
      e.preventDefault();
      list.at(-1)?.focus();
    } else if (!e.shiftKey && document.activeElement === list.at(-1)) {
      e.preventDefault();
      list[0]?.focus();
    }
  }
}
function gridKey(e: KeyboardEvent, index: number) {
  let next = index;
  if (e.key === "ArrowRight") next++;
  else if (e.key === "ArrowLeft") next--;
  else if (e.key === "ArrowDown") next += columns;
  else if (e.key === "ArrowUp") next -= columns;
  else return;
  e.preventDefault();
  board?.querySelectorAll<HTMLButtonElement>(
    ".wb-card",
  )[Math.max(0, Math.min(matches.length - 1, next))]?.focus();
}
onMount(() => {
  void load();
  void loadAgent();
  restoreDraft();
  const observer = new ResizeObserver(([entry]) => {
    width = entry.contentRect.width;
    height = entry.contentRect.height;
  });
  observer.observe(board);
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  const mobileQuery = matchMedia("(max-width: 900px)");
  const resize = () => mobile = mobileQuery.matches;
  resize();
  mobileQuery.addEventListener("change", resize);
  const motion = () => reduced = media.matches;
  motion();
  media.addEventListener("change", motion);
  const agentTimer = setInterval(() => {
    if (!document.hidden) void loadAgent();
  }, 3000);
  const timer = setInterval(() => {
    if (!document.hidden) void load();
  }, 10000);
  return () => {
    observer.disconnect();
    clearInterval(timer);
    clearInterval(agentTimer);
    media.removeEventListener("change", motion);
    mobileQuery.removeEventListener("change", resize);
  };
});
</script>
<svelte:window onkeydown={keys} />
<div class="wb-shell">
 <Sidebar {lang} active="workbench" plugins={agentState?.catalog?.plugins || []} onSettings={()=>preferences=true} onSource={(p)=>location.href='/?module='+encodeURIComponent(p.id)} inert={mobile && drawer}/>

 <main class="wb-main" inert={mobile && drawer}>
  <header class="wb-top"><span class="wb-eyebrow">LOCALDESK · 0.2.1 <span class="wb-preview">{t('preview')}</span></span>
   <div class="wb-settings">
    <select aria-label={t('language')} bind:value={lang}><option value="en">EN</option><option value="zh-TW">繁</option><option value="zh-CN">简</option></select>
    <select aria-label={t('theme')} bind:value={theme}><option value="system">{t('system')}</option><option value="light">{t('light')}</option><option value="dark">{t('dark')}</option></select>
    <select aria-label={t('typography')} bind:value={font}><option value="system">Aa</option><option value="pixel">{t('pixel')}</option></select>
   </div>
  </header>
  <section class="wb-heading"><div><div class="wb-display"><DotWord text="WORK"/></div><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><div class="wb-stats"><strong>{number(projects.length)}</strong><span>{t('total')}</span><small>{number(dirty)} {t('changedTotal')}</small></div></section>
  <div class="wb-tools"><div class="wb-filters" aria-label={t('projects')}>{#each (agentState && !agentState.readOnly ? ['all','changed','web','native'] : ['all','changed']) as f}<button class:active={filter===f} aria-pressed={filter===f} onclick={()=>filter=f}>{t(f)}</button>{/each}</div><label class="wb-search"><Search size={15}/><input id="workbench-search" aria-label={t('search')} placeholder={t('search')} bind:value={query}/><kbd>⌘K</kbd></label><button class="wb-refresh" class:busy={refreshing} aria-label={t('refresh')} onclick={refreshProjects} disabled={refreshing||!agentState?.canControl}><RefreshCw size={16}/></button></div>
  {#if error||data?.stale}<div class="wb-warning" role="status">{error?t('error'):data?.snapshot?t('stale'):t('noSnapshot')}<small>{error||data?.error}</small></div>{/if}
  <div class="wb-board" class:tight bind:this={board} style={`--columns:${columns};--rows:${rows}`}>
   {#each matches as p,i (p.name)}
    <button class="wb-card" class:selected={selectedName===p.name} class:dirty={p.is_dirty} onclick={(event)=>pick(p,event)} onkeydown={(event)=>gridKey(event,i)} aria-pressed={selectedName===p.name} aria-label={`${p.name}, ${changed(p)}`} title={`${p.name}\n${changed(p)}\n${p.path}`}>
     <div class="wb-card-top"><span class="wb-project-code">{p.name.split('-')[0].slice(0,2)}</span><span class="wb-runtime-mark" class:responding={p.runtime?.reachability?.frontend==='reachable'}></span><ChevronRight size={12}/></div>
     <strong>{p.name}</strong><div class="wb-card-bottom"><span class:has-changes={p.is_dirty}>{changed(p)}</span><code>{p.runtime?.ports?.frontend?':'+p.runtime.ports.frontend:state(p.runtime?.kind)}</code></div>
    </button>
   {/each}
   {#if !matches.length}<div class="wb-empty"><Folder size={26}/>{data?.connected===false?(translations[lang]||translations.en).sourceOffline:data?.snapshot?t('empty'):data?.stale?t('noSnapshot'):t('loading')}</div>{/if}
  </div>
  <footer class="wb-footer"><span>{t('sourceNote')}</span><span>{t('response')} <b>{responseMs} ms</b> · {t('updated')} {time(data?.snapshot?.scanned_at)}</span></footer>
 </main>
 {#if drawer}<button class="wb-backdrop" aria-label={t('close')} onclick={close} transition:fade={{ duration: reduced ? 0 : 100 }}></button>{/if}
 <aside class="wb-inspector" class:open={drawer} bind:this={inspector} tabindex="-1" role={mobile ? "dialog" : "complementary"} aria-modal={mobile && drawer ? true : undefined} inert={mobile && !drawer} aria-label={t('selected')}>
  {#if selected}
   <div class="wb-inspector-head"><span class="wb-eyebrow">{t('selected')}</span><button class="wb-mobile-close" aria-label={t('close')} onclick={close}><X size={19}/></button></div>
   {#key selectedName}<div class="wb-identity" in:fade={{ duration: reduced ? 0 : 130 }}><span class="wb-large-code">{selected.name.split('-')[0].slice(0,2)}</span><div><h2>{selected.name}</h2><span>{changed(selected)} · {selected.has_remote?t('remote'):t('local')}</span></div></div>{/key}
   <div class="wb-tabs"><button class:active={tab==='overview'} onclick={()=>tab='overview'}>{t('overview')}</button><button class:active={tab==='request'} onclick={()=>tab='request'}>{t('request')} <ArrowUpRight size={13}/></button></div>
   <div class="wb-inspector-body">
   {#if tab==='overview'}
    <div class="wb-detail" in:fade={{ duration: reduced ? 0 : 100 }}>
     <div class="wb-section-label"><GitBranch size={14}/> GIT</div>
     <dl><div><dt>{t('branch')}</dt><dd>{selected.branch||t('noGit')}</dd></div><div><dt>{t('branches')}</dt><dd>{selected.has_multiple_branches?t('multiple'):t('single')}</dd></div><div><dt>{t('upstream')}</dt><dd>{selected.upstream||t('upstreamNone')}</dd></div><div><dt>{t('changes')}</dt><dd>{number(selected.changed_count)}</dd></div><div><dt>{t('ahead')} / {t('behind')}</dt><dd><ArrowUp size={12}/>{number(selected.ahead_count)} <ArrowDown size={12}/>{number(selected.behind_count)}</dd></div></dl>
     <div class="wb-section-label"><CircleDot size={14}/>{t('runtime')} <span>{state(selected.runtime?.kind)}</span></div>
     <dl>{#each ['frontend','backend'] as role}<div><dt>{t(role)}</dt><dd>{state(selected.runtime?.reachability?.[role])}{#if selected.runtime?.ports?.[role]}{#if role==='frontend' && selected.runtime.ports.frontend_endpoint}<a href={link(selected.runtime.ports[role])} target="_blank" rel="noreferrer" aria-label={`${t('open')} ${selected.name} ${t(role)}`}>:{selected.runtime.ports[role]}<ArrowUpRight size={12}/></a>{:else}<code>:{selected.runtime.ports[role]}</code>{/if}{/if}</dd></div>{/each}{#each ['manager','startup','restart'] as field}<div><dt>{t(field)}</dt><dd>{state(selected.runtime?.management?.[field])}</dd></div>{/each}</dl>
     <div class="wb-section-label"><Code2 size={14}/>{t('source')}</div><dl><div><dt>{t('core')} / {t('test')}</dt><dd>{number(selected.loc?.core)} / {number(selected.loc?.test)}</dd></div>{#each selected.loc?.parts||[] as part}<div><dt>{part.id==='mac'?'macOS':part.id==='firmware'?t('firmware'):part.id}</dt><dd>{number(part.core)}</dd></div>{/each}<div><dt>{t('profile')}</dt><dd>{selected.loc?.profile||'—'}</dd></div><div><dt>{t('counted')}</dt><dd>{time(selected.loc?.counted_at)}</dd></div><div><dt>{t('elapsed')}</dt><dd>{data?.snapshot?.duration_ms==null?'—':number(data.snapshot.duration_ms/1000)} {t('seconds')}</dd></div></dl>
     <div class="wb-path"><span>{t('workspace')}</span><code>{selected.path}</code></div>
     <div class="wb-quick">{#each ['inspect','health','improve'] as action}<button onclick={()=>suggestion(action)}>{t(action)}<ArrowUpRight size={14}/></button>{/each}</div>
    </div>
   {:else}
    <div class="wb-request" in:fade={{ duration: reduced ? 0 : 100 }}>
     <div class="wb-path"><span>{t('workspace')}</span><code>{selected.path}</code></div>
     <div class="wb-conversations"><select aria-label={t('conversation')} value={currentChatId} onchange={(e)=>selectConversation(e.currentTarget.value)}><option value="">{t('newConversation')}</option>{#each projectChats as c}<option value={c.id}>{c.archived?'↳ ':''}{c.title||t('newConversation')}</option>{/each}</select><button aria-label={t('newConversation')} onclick={()=>{selectConversation('');newDraft();}}><Plus size={17}/></button></div>
     <details class="wb-saved-drafts"><summary>{t('drafts')} ({drafts[selectedName]?.length||0})</summary><div class="wb-drafts"><select aria-label={t('drafts')} bind:value={draftId} onchange={()=>restoreDraft(draftId)}>{#if !drafts[selectedName]?.length}<option value="">{t('draftTitle')}</option>{/if}{#each drafts[selectedName]||[] as d,i}<option value={d.id}>{i+1}. {d.text.slice(0,38)||t('draftTitle')}</option>{/each}</select><button aria-label={t('newDraft')} onclick={newDraft}><Plus size={17}/></button></div></details>
     <textarea aria-label={t('prompt')} placeholder={t('prompt')} bind:value={draft.text} oninput={saveDraft}></textarea>
     <div class="wb-agent-options"><label>{t('model')}<select aria-label={t('model')} bind:value={draft.preset} onchange={presetChange}>{#each options as p}<option value={p.name}>{p.name}</option>{/each}</select></label><label>{t('effort')}<select aria-label={t('effort')} bind:value={draft.effort} onchange={saveDraft}>{#each chosen?.efforts||[] as effort}<option value={effort}>{effort}</option>{/each}</select></label><button class="wb-fast" class:active={draft.fast} disabled={!chosen?.fastAvailable} aria-pressed={draft.fast} aria-label={`${t('fast')}: ${draft.fast?t('on'):t('off')}`} onclick={()=>{draft.fast=!draft.fast;saveDraft();}}><Zap size={14}/>{t('fast')}</button></div>
     <p class="wb-hint">{!runner?.ready?(runner?.errorCode==='model_unconfigured'?t('modelUnconfigured'):runner?.error||t('agentOffline')):agentState?.canControl?t('hint'):t('readOnly')}</p><button class="wb-prepare" onclick={sendInstruction} disabled={sending||!draft.text.trim()||!chosen||!runner?.ready||!agentState?.canControl||currentChat?.archived}>{sending?t('sending'):t('send')}<ArrowUpRight size={17}/></button>
     {#if currentChatId}<a class="wb-open-chat" href={`/?view=activity&chat=${currentChatId}`}>{t('openConversation')}<ArrowUpRight size={14}/></a>{/if}
     {#if latestTurn}<div class="wb-live-result" role="status"><strong>{t(latestTurn.state)}</strong><p>{latestTurn.error||latestTurn.result||t('waiting')}</p>{#if ['queued','running'].includes(latestTurn.state)}<button onclick={stopWork}>{t('stop')}</button>{/if}</div>{/if}
     <button class="wb-preview-request" onclick={prepare} disabled={!draft.text.trim()||!chosen}>{t('prepare')}<ArrowUpRight size={17}/></button>
     {#if prepared}<div class="wb-receipt" role="status" in:fade={{ duration: reduced ? 0 : 150 }}><span><Check size={16}/>{t('prepared')}</span><p>{t('preparedHint')}</p><pre>{prepared}</pre><button onclick={copyRequest}><Copy size={14}/>{copied?t('copied'):t('copy')}</button></div>{:else}<div class="wb-draft-note"><MessageSquare size={17}/><p>{t('noThread')}<small>{draft.id?t('saved'):t('retained')}</small></p></div>{/if}
    </div>
   {/if}
   </div>
   <div class="wb-inspector-footer"><span class="wb-dot"></span>{t('notice')}</div>
  {:else}<div class="wb-empty"><Folder size={28}/>{data?.connected===false?(translations[lang]||translations.en).sourceOffline:data?.snapshot?t('empty'):data?.stale?t('noSnapshot'):t('loading')}</div>{/if}
 </aside>
</div>

{#if preferences}<Preferences bind:lang bind:theme bind:font
  onSourcesChanged={load} onClose={()=>preferences=false} />{/if}
