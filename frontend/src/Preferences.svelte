<script lang="ts">
import { onMount } from "svelte";
import { Monitor, Moon, Sun, X } from "@lucide/svelte";
import DotWord from "./DotWord.svelte";
import { readStartPage, translations, trapFocus } from "./ui";
export let lang = "en", theme = "system", font = "system";
export let onClose: () => void;
export let onSourcesChanged: () => Promise<void> = async () => {};
let sources: any[] = [], activeJobs = false, busy = "", sourceError = "", scanError = false, projectError = false;
async function loadSources() {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error(String(response.status));
  const state = await response.json();
  sources = state.integrations || [];
  activeJobs = state.jobs.some((job: any) => ["queued", "running"].includes(job.state));
  const workbench = await fetch("/api/workbench");
  if (!workbench.ok) throw new Error(String(workbench.status));
  projectError = !!(await workbench.json()).error;
  scanError = state.catalog.errors.length > 0 || state.catalog.plugins.some((p: any) => p.error);
}
onMount(() => { loadSources().catch(() => sourceError = "sourceFailure"); });
async function changeSource(source: any) {
  busy = source.id; sourceError = "";
  let accepted = false;
  try {
    const response = await fetch("/api/integrations", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({id: source.id, connected: !source.connected})});
    const result = await response.json();
    if (!response.ok) {
      sourceError = result.error.includes("jobs in Activity") ? "sourceJobs" : "sourceFailure";
    } else {
      accepted = true;
      sources = result.integrations;
    }
    try {
      await loadSources();
      await onSourcesChanged();
    } catch { if (accepted) sourceError = "sourceRefreshFailed"; }
  } catch { sourceError = "sourceUnknown"; }
  finally { busy = ""; }
}
let startPage = readStartPage();
$: t = (key: string) => (translations[lang] || translations.en)[key] || key;
$: localStorage.setItem("localdesk-start-page", startPage);
</script>
<svelte:window
  onkeydown={(e)=>{if(e.key==='Escape'){e.stopPropagation();onClose();}}} />
<div class="scrim" role="presentation"
  onclick={(e)=>{if(e.target===e.currentTarget)onClose();}}>
  <div class="preferences" use:trapFocus role="dialog" aria-modal="true"
    aria-label={t('settings')} tabindex="-1">
  <div class="drawer-header"><DotWord text="LOCAL"/><button class="icon-button" aria-label={t('close')} onclick={onClose}><X size={20}/></button></div>
  <h2>{t('settings')}</h2>
  <label>{t('startPage')}<select aria-label={t('startPage')} bind:value={startPage}>{#each ['overview','workbench','activity'] as view}<option value={view}>{t(view)}</option>{/each}</select></label><p class="muted-note">{t('startPageHint')}</p>
  <label>{t('language')}<select aria-label={t('language')} bind:value={lang}>{#each Object.entries(translations) as [id,d]}<option value={id}>{d.localeName}</option>{/each}</select></label>
  <div class="pref-group"><span>{t('theme')}</span><div class="segmented">{#each ['system','light','dark'] as th}<button class:active={theme===th} onclick={()=>theme=th}>{#if th==='system'}<Monitor size={16}/>{:else if th==='light'}<Sun size={16}/>{:else}<Moon size={16}/>{/if}{t(th)}</button>{/each}</div></div>
  <div class="pref-group"><span>{t('font')}</span><div class="segmented">{#each ['system','pixel'] as f}<button class:active={font===f} onclick={()=>font=f}>{t(f)}</button>{/each}</div><p class="font-sample">{t('fontSample')}</p></div>
  <section class="pref-group" aria-label={t('integrations')}>
    <strong>{t('integrations')}</strong>
    <p class="muted-note">{t('sourceHint')}</p>
    {#each sources as source}
      <div class="source-connection">
        <div><strong>{t(source.id==='workspace'?'sourceWorkspace':'sourceProjects')}</strong><small>{t(!source.connected?'sourceDisconnected':(source.id==='workspace'?scanError:projectError)?'sourceScanError':'sourceConnected')}</small><code>{source.path}</code></div>
        <button class="inspect-button" data-source={source.id} disabled={!!busy||source.changing||(source.connected&&activeJobs)} onclick={()=>changeSource(source)}>{busy===source.id?t('sourceChanging'):t(source.connected?'sourceDisconnect':'sourceConnect')}</button>
      </div>
    {/each}
    {#if activeJobs}<p class="muted-note">{t('sourceJobs')} <a href="/?view=activity">{t('sourceActivity')}</a></p>{/if}
    {#if sourceError}<p role="alert">{t(sourceError)}</p>{/if}
    <p class="muted-note">{t('sourceRetention')}</p>
  </section>
 </div>
</div>
