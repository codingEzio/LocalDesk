<script lang="ts">
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  MessageSquare,
  Plus,
  Square,
} from "@lucide/svelte";
export let chats: any[] = [];
export let activeId = "";
export let turns: any[] = [];
export let t: (key: string) => string;
export let date: (value: string) => string;
export let onSelect: (id: string) => void;
export let onNew: () => void;
export let onArchive: (chat: any, value: boolean) => void;
export let onDetails: (turn: any) => void;
export let onStop: (turn: any) => void;
export let canControl = false;
export let actionId = "";
export let workspace = "";
let archived = false;
$: selected = chats.find((c) => c.id === activeId);
$: visible = chats.filter((c) => c.archived === archived);
$: latest = turns.at(-1);
</script>
<section class="chat-workspace" aria-label={t('activity')}>
  <aside class="chat-browser">
    <div
      class="chat-browser-heading"><span class="eyebrow">{t('yourChats')}</span><button class="icon-button" aria-label={t('newChat')} onclick={onNew} disabled={!canControl}><Plus size={17}/></button></div>
    <div
      class="chat-tabs"><button class:active={!archived} onclick={()=>archived=false}>{t('activity')} <span>{chats.filter(c=>!c.archived).length}</span></button><button class:active={archived} onclick={()=>archived=true}>{t('archived')}</button></div>
    <div
      class="chat-index">{#each visible as chat}<button class="chat-index-row" class:selected={chat.id===activeId} onclick={()=>onSelect(chat.id)}><span class="chat-list-title"><i class:busy={chat.busy}></i>{chat.title||t('newChat')}</span><span class="chat-list-meta">{chat.workspace?.split("/").pop()||t("workspace")} · {date(chat.updatedAt)} <b>{chat.turns} {t(chat.turns===1?'turn':'turns')}</b></span></button>{/each}{#if !visible.length}<p class="muted-note">{t('noChats')}</p>{/if}</div>
  </aside>
  <div class="chat-conversation">
  <header class="conversation-heading"><div><span class="eyebrow">{selected?.threadId?`CODEX / ${selected.threadId.slice(0,8)}`:t('localSession')}</span><h1>{selected?.title||t('newChat')}</h1><code class="chat-target">{selected?.workspace||workspace}</code></div>{#if selected}<button class="icon-button" aria-label={t(selected.archived?'restoreChat':'archiveChat')} title={t(selected.archived?'restoreChat':'archiveChat')} disabled={selected.busy||!canControl||actionId===selected.id} aria-busy={actionId===selected.id} onclick={()=>onArchive(selected,!selected.archived)}>{#if selected.archived}<ArchiveRestore size={17}/>{:else}<Archive size={17}/>{/if}</button>{/if}</header>
  {#if actionId&&actionId===activeId}<div class="chat-notice" role="status">{t('updatingChat')}</div>{/if}
  <div class="chat-transcript" aria-live="polite" aria-relevant="additions text">
   {#each turns as turn (turn.id)}<article class="chat-turn"><div class="user-message"><span>{t('you')} · {date(turn.createdAt)}</span><p>{turn.prompt}</p></div><div class="agent-message"><div class="reply-meta"><span><i class:busy={turn.state==='running'}></i>{turn.model??'CODEX'}</span><span>{turn.effort} {turn.tier==='priority'?'· Fast':''}</span></div>{#if turn.error}<p class="chat-error">{turn.error}</p>{/if}<p class="reply-text">{turn.result??t(['queued','running'].includes(turn.state)?'pending':turn.state)}</p><div class="reply-actions"><span class="state-tag" data-state={turn.state}>{t(turn.state)}</span><button onclick={()=>onDetails(turn)}>{t('events')} <ChevronRight size={12}/></button>{#if ['queued','running'].includes(turn.state)}<button class="stop-inline" onclick={()=>onStop(turn)}><Square size={11}/>{t('stop')}</button>{/if}</div></div></article>{/each}
   {#if !turns.length}<div class="chat-welcome"><span class="welcome-glyph"><MessageSquare size={26} strokeWidth={1}/></span><h2>{t('chatWelcome')}</h2><p>{t('chatWelcomeHint')}</p><code>{workspace}</code></div>{/if}
  </div>
  {#if selected?.archived}<div class="chat-notice">{t('archiveNote')}<button disabled={actionId===selected.id} onclick={()=>onArchive(selected,false)}>{t('restoreChat')}</button></div>{:else if latest?.state==='failed'&&selected?.threadId}<div class="chat-notice">{t('restoreHint')}<button disabled={actionId===selected.id} onclick={()=>onArchive(selected,false)}>{t('restoreChat')}</button><button onclick={onNew}>{t('newChat')}</button></div>{/if}
 </div>
</section>
