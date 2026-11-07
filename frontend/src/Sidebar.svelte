<script lang="ts">
import {
  FolderKanban,
  Grid2X2,
  MessageSquare,
  Settings2,
  SlidersHorizontal,
} from "@lucide/svelte";
import { translations } from "./ui";
export let lang = "en", active = "overview";
export let plugins: any[] = [];
export let onSource: (p: any) => void;
export let onSettings: () => void;
export let inert = false;
$: t = (key: string) => (translations[lang] || translations.en)[key] || key;
const nav = [
  { id: "overview", url: "/?view=overview", icon: Grid2X2 },
  { id: "workbench", url: "/workbench", icon: FolderKanban },
  { id: "activity", url: "/?view=activity", icon: MessageSquare },
  { id: "skills", url: "/?view=skills", icon: SlidersHorizontal },
  { id: "modules", url: "/?view=modules", icon: SlidersHorizontal },
];
</script>
<aside class="desk-sidebar" {inert}>
  <a class="desk-brand" href="/?view=overview"
    aria-label="LocalDesk"><span class="desk-glyph" aria-hidden="true">{#each Array(9) as _}<i></i>{/each}</span><span>LOCAL<br/><b>DESK</b></span></a>
  <span class="desk-label">01 / {t('workspace')}</span>
  <nav
    aria-label={t('workspace')}>{#each nav as item}<a href={item.url} class:chosen={active===item.id} aria-current={active===item.id?'page':undefined}><svelte:component this={item.icon} size={17}/><span>{t(item.id)}</span></a>{/each}</nav>
  <div
    class="desk-sources"><span class="desk-label">02 / {t('sources')}</span>{#each plugins as p}<button onclick={()=>onSource(p)} class:muted={!p.enabled}><i></i><span>{p.title?.[lang]||p.title?.en||p.id}</span><small>{p.items.length}</small></button>{/each}</div>
  <div
    class="desk-bottom"><span class="desk-label"><i></i>{t('local')}</span><code>:{location.port || (location.protocol === "https:" ? "443" : "80")}</code><button class="desk-settings" onclick={onSettings}><Settings2 size={17}/><span>{t('settings')}</span></button></div>
</aside>
