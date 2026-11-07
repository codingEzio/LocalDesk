<script lang="ts">
import { onMount } from "svelte";
export let lang = "en";
const copy:Record<string,Record<string,string>>={
 en:{title:"Skills",search:"Search names and descriptions",all:"All purposes",empty:"No skills in this source",name:"Skill name",description:"Description",category:"Purpose",preview:"Preview changes",apply:"Apply selected changes",cancel:"Back to editing",refresh:"Refresh",categories:"Manage categories",add:"Add category",save:"Save categories",remove:"Remove",label:"Category label",newCategory:"New category",readOnly:"Linked or invalid entry · read-only",references:"Files and references",required:"Required",optional:"Optional reference",before:"Before",after:"After",saved:"Saved and read back",recover:"Recover interrupted change",loading:"Loading…",source:"Source",selected:"Selected skill",scope:"Reference search scope",expiry:"Preview valid until {time}. Changed files require a new preview.",noChanges:"No file changes",pending:"An interrupted change requires recovery before saving.",keep:"Keep or exclude individual references before applying.",close:"Close",error:"Unable to complete this change"},
 "zh-CN":{title:"技能",search:"搜索名称与描述",all:"全部用途",empty:"此来源没有技能",name:"技能名称",description:"描述",category:"用途分类",preview:"预览变更",apply:"应用所选变更",cancel:"返回编辑",refresh:"刷新",categories:"管理分类",add:"添加分类",save:"保存分类",remove:"移除",label:"分类名称",newCategory:"新分类",readOnly:"链接或无效入口 · 只读",references:"文件与引用",required:"必须更新",optional:"可选引用",before:"变更前",after:"变更后",saved:"已保存并读回",recover:"恢复中断的变更",loading:"载入中…",source:"来源",selected:"所选技能",scope:"引用搜索范围",expiry:"预览有效期至 {time}；文件发生变化后须重新预览。",noChanges:"没有文件变更",pending:"有中断的变更，保存前请先恢复。",keep:"应用前可以保留或排除引用。",close:"关闭",error:"未能完成此变更"},
 "zh-TW":{title:"技能",search:"搜尋名稱與描述",all:"全部用途",empty:"此來源沒有技能",name:"技能名稱",description:"描述",category:"用途分類",preview:"預覽變更",apply:"套用所選變更",cancel:"返回編輯",refresh:"重新整理",categories:"管理分類",add:"新增分類",save:"儲存分類",remove:"移除",label:"分類名稱",newCategory:"新分類",readOnly:"連結或無效入口 · 唯讀",references:"檔案與引用",required:"必須更新",optional:"可選引用",before:"變更前",after:"變更後",saved:"已儲存並讀回",recover:"復原中斷的變更",loading:"載入中…",source:"來源",selected:"所選技能",scope:"引用搜尋範圍",expiry:"預覽有效期至 {time}；檔案變更後須重新預覽。",noChanges:"沒有檔案變更",pending:"有中斷的變更，儲存前請先復原。",keep:"套用前可以保留或排除引用。",close:"關閉",error:"未能完成此變更"}
};
$: t=copy[lang]||copy.en;
let data:any=null,error="",notice="",busy=false,query="",filter="",selected="",draftName="",draftDescription="",draftCategory="uncategorized",plan:any=null,checked:number[]=[],editingCategories=false,categories:any[]=[],newLabel="";
$: items=(data?.items||[]).filter((i:any)=>(!filter||i.category===filter)&&(`${i.name} ${i.description} ${i.folder}`.toLowerCase().includes(query.toLowerCase())));
$: current=data?.items.find((i:any)=>i.folder===selected);
const title=(c:any)=>c?.title?.[lang]||c?.title?.en||c?.id||"";
const categoryTitle=(id:string)=>title(data?.categories.find((c:any)=>c.id===id));
const errorMessages:Record<string,[string,string]>={
 "Skill changed since opening":["技能在打开后已变化；请刷新并重新选择","技能在開啟後已變更；請重新整理並重新選擇"],
 "Preview expired":["预览已过期，请重新预览","預覽已過期，請重新預覽"],
 "Categories changed":["分类已变化，请刷新后重试","分類已變更，請重新整理後再試"],
 "File changed":["文件已变化，请重新预览；中断时先恢复","檔案已變更，請重新預覽；中斷時先復原"],
 "Reference scope changed":["引用范围已变化，请重新预览","引用範圍已變更，請重新預覽"],
 "Destination already exists":["目标名称已存在，请使用其他名称","目標名稱已存在，請使用其他名稱"],
 "Case-insensitive":["目标名称存在大小写冲突","目標名稱存在大小寫衝突"],
 "Linked skills":["链接技能的名称与描述只读","連結技能的名稱與描述唯讀"],
 "Move skills out":["请先移出此分类内的技能，再移除分类","請先移出此分類內的技能，再移除分類"],
 "Unknown category":["分类不存在，请刷新","分類不存在，請重新整理"],
 "Invalid skill fields":["名称须为小写字母、数字和连字符且不超过64字符；描述不能为空","名稱須為小寫字母、數字和連字號且不超過64字元；描述不能為空"],
 "Invalid categories":["请检查分类标识与三种语言的名称","請檢查分類識別碼與三種語言的名稱"],
 "Recover":["请先恢复中断的变更","請先復原中斷的變更"],
 "Lock belongs":["此锁属于另一个应用，请在那里恢复","此鎖屬於另一個應用程式，請在該處復原"],
 "Lock owner is still running":["持锁应用仍在运行，不能接管","持鎖應用程式仍在執行，不能接管"],
 "Operation still running":["变更仍在执行，请等待","變更仍在執行，請稍候"],
 "Another skill operation":["另一个技能变更正在执行","另一個技能變更正在執行"],
 "Select or exclude":["生成文档与固定值必须整组选择或排除","產生的文件與固定值必須整組選取或排除"],
 "Reference scan exceeds":["引用扫描超过上限，请缩小来源范围","引用掃描超過上限，請縮小來源範圍"],
 "Reference scope too large":["引用范围超过上限，请缩小范围","引用範圍超過上限，請縮小範圍"],
 "Pinned document drift":["生成文档与固定值不一致，请先同步","產生的文件與固定值不一致，請先同步"],
 "Readback mismatch":["保存读回不一致，请查看恢复状态","儲存讀回不一致，請查看復原狀態"]
};
function translateError(value:string){if(lang==='en')return value;const entry=Object.entries(errorMessages).find(([key])=>value.includes(key));return entry?entry[1][lang==='zh-TW'?1:0]+' · '+value:t.error+' · '+value;}
async function api(path:string,body?:unknown){const r=await fetch('/api/skills'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.error||String(r.status));return value;}
async function load(){try{data=await api('?fresh=1');if(selected&&!data.items.some((i:any)=>i.folder===selected))selected='';if(!selected&&data.items.length)choose(data.items[0]);}catch(e){error=translateError(String(e));}}
function choose(item:any){selected=item.folder;draftName=item.name;draftDescription=item.description;draftCategory=item.category;plan=null;error='';notice='';}
async function act(fn:()=>Promise<void>){if(busy)return;busy=true;error='';notice='';try{await fn();}catch(e){error=translateError(String(e));}finally{busy=false;}}
function toggle(index:number){const group=plan.files[index].group;const indices=plan.files.filter((f:any)=>group?f.group===group:f.index===index).map((f:any)=>f.index);const remove=checked.includes(index);checked=remove?checked.filter(n=>!indices.includes(n)):[...new Set([...checked,...indices])];}
async function preview(){await act(async()=>{plan=await api('/preview',{folder:selected,name:draftName,description:draftDescription,category:draftCategory,expected:current.revision});checked=plan.files.filter((f:any)=>f.selected).map((f:any)=>f.index);});}
async function assign(){await act(async()=>{await api('/assignment',{folder:selected,category:draftCategory,revision:data.revision});await load();notice=t.saved;});}
async function apply(){await act(async()=>{const value=await api('/apply',{id:plan.id,selected:checked});plan=null;await load();const found=data.items.find((i:any)=>i.folder===value.name);if(found)choose(found);notice=t.saved+' · '+value.id;});}
function manage(){categories=structuredClone(data.categories);editingCategories=!editingCategories;}
function addCategory(){if(!newLabel.trim())return;categories=[...categories,{id:'custom-'+crypto.randomUUID(),title:{en:newLabel.trim(),'zh-CN':newLabel.trim(),'zh-TW':newLabel.trim()}}];newLabel='';}
async function saveCategories(){await act(async()=>{await api('/categories',{revision:data.revision,categories});editingCategories=false;await load();notice=t.saved;});}
onMount(load);
</script>
<section class="skills-manager" aria-labelledby="skills-title">
 <div class="skill-heading"><h1 id="skills-title">{t.title}</h1><div class="skill-actions"><button disabled={busy||!data} onclick={manage}>{t.categories}</button><button disabled={busy} onclick={()=>act(load)}>{t.refresh}</button></div></div>
 {#if error}<p class="skill-error" role="alert">{error}</p>{/if}
 {#if notice}<p class="skill-notice" role="status">{notice}</p>{/if}
 {#if !data}<p>{t.loading}</p>{:else}
 <p class="skill-source"><span>{t.source}</span> <code>{data.source}</code></p>
 {#if data.pending}<div class="skill-error"><p>{t.pending}</p><button disabled={busy} onclick={()=>act(async()=>{await api('/recover',{});await load();notice=t.saved;})}>{t.recover}</button></div>{/if}
 {#if editingCategories}
 <section class="category-editor" aria-label={t.categories}>
 {#each categories as c}<div class="category-line"><label>{t.label}<input value={title(c)} oninput={(e)=>{c.title={...c.title,[lang]:e.currentTarget.value};}} /></label><span>{data.items.filter((i:any)=>i.category===c.id).length}</span><button disabled={c.id==='uncategorized'||data.items.some((i:any)=>i.category===c.id)} onclick={()=>categories=categories.filter((x:any)=>x.id!==c.id)}>{t.remove}</button></div>{/each}
 <div class="skill-actions"><input aria-label={t.newCategory} placeholder={t.newCategory} bind:value={newLabel}/><button onclick={addCategory}>{t.add}</button><button disabled={busy} onclick={saveCategories}>{t.save}</button></div>
 </section>
 {/if}
 <div class="skill-filters"><input aria-label={t.search} placeholder={t.search} bind:value={query}/><select aria-label={t.category} bind:value={filter}><option value="">{t.all} · {data.items.length}</option>{#each data.categories as c}<option value={c.id}>{title(c)} · {data.items.filter((i:any)=>i.category===c.id).length}</option>{/each}</select></div>
 <div class="skill-layout">
 <div class="skill-list" aria-label={t.title}>{#each items as item}<button class:chosen={selected===item.folder} onclick={()=>choose(item)}><strong>{item.folder}</strong><span>{categoryTitle(item.category)}{item.editable?'':' · '+t.readOnly}</span><p>{item.description||item.error}</p></button>{/each}{#if !items.length}<p>{t.empty}</p>{/if}</div>
 {#if current}
 <section class="skill-editor" aria-label={t.selected}>
 <code class="editor-path">{current.path}</code>
 {#if current.error}<p class="skill-error">{current.error}</p>{/if}
 {#if !current.editable}<p>{t.readOnly}</p><code>{current.target||''}</code>{/if}
 {#if !plan}
 <label>{t.name}<input bind:value={draftName} disabled={!current.editable||busy} maxlength="64" autocomplete="off" spellcheck="false"/></label>
 <label>{t.description}<textarea bind:value={draftDescription} disabled={!current.editable||busy} rows="7" maxlength="4096"></textarea></label>
 <label>{t.category}<select bind:value={draftCategory} disabled={busy}>{#each data.categories as c}<option value={c.id}>{title(c)}</option>{/each}</select></label>
 <details><summary>{t.scope}</summary>{#each data.referenceRoots as path}<code class="reference-root">{path}</code>{/each}</details>
 <button class="skill-primary" disabled={busy||!!data.pending||(current.editable&&(!draftName||!draftDescription.trim()))} onclick={current.editable?preview:assign}>{busy?t.loading:current.editable?t.preview:t.save}</button>
 {:else}
 <h2>{plan.folder}{plan.renamed?' → '+plan.name:''}</h2><p>{t.expiry.replace('{time}',new Date(plan.expiresAt).toLocaleString(lang))}</p><h3>{t.references} · {plan.files.length}</h3><p>{t.keep}</p>
 {#each plan.files as f}<details class="reference-file"><summary><label><input type="checkbox" checked={checked.includes(f.index)} disabled={f.required||busy} onchange={()=>toggle(f.index)}/><span>{f.path}<small>{f.required?t.required:t.optional}{f.group?' · '+f.group:''}</small></span></label></summary><div class="diff-columns"><div><strong>{t.before}</strong><pre>{f.before}</pre></div><div><strong>{t.after}</strong><pre>{f.after}</pre></div></div></details>{/each}
 {#if !plan.files.length}<p>{t.noChanges}</p>{/if}
 <div class="skill-actions"><button disabled={busy} onclick={()=>plan=null}>{t.cancel}</button><button class="skill-primary" disabled={busy} onclick={apply}>{busy?t.loading:t.apply}</button></div>
 {/if}
 </section>
 {/if}
 </div>
 {/if}
</section>
<style>
.skills-manager{flex:1;min-height:0;overflow:auto;box-sizing:border-box;width:100%;max-width:1600px;margin:0 auto;padding:24px;min-width:0}.skill-heading,.skill-actions,.category-line,.skill-filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.skill-heading{justify-content:space-between}.skill-heading h1{font-size:28px;margin:0}.skill-source{font-size:12px;overflow-wrap:anywhere;opacity:.75}.skill-layout{display:grid;grid-template-columns:minmax(260px,1fr) minmax(340px,1.2fr);gap:20px;align-items:start}.skill-list{display:grid;gap:6px;min-width:0}.skills-manager button,.skills-manager input,.skills-manager select,.skills-manager textarea{font:inherit;color:inherit;border:1px solid var(--line,#8885);border-radius:8px;background:var(--panel,transparent);padding:9px 12px;min-width:0}.skills-manager button{cursor:pointer}.skills-manager button:disabled{opacity:.45;cursor:default}.skill-list button{text-align:left;display:grid;gap:5px}.skill-list strong{font-size:13px;overflow-wrap:anywhere}.skill-list span{font-size:11px;opacity:.65}.skill-list p{font-size:12px;line-height:1.5;margin:0;opacity:.8}.skill-list .chosen{border-color:currentColor;background:#8881}.skill-editor{position:sticky;top:20px;border:1px solid #8884;border-radius:12px;padding:18px;display:grid;gap:16px;min-width:0}.skill-editor label{display:grid;gap:6px;font-size:12px}.skill-editor textarea{resize:vertical;width:100%;box-sizing:border-box;line-height:1.5}.editor-path,.reference-root{overflow-wrap:anywhere;font-size:11px;display:block}.skill-filters{margin:18px 0}.skill-filters input{flex:1;min-width:220px}.skill-primary{font-weight:650!important;border-color:currentColor!important}.skill-error{border-left:3px solid #d44;padding:10px;overflow-wrap:anywhere}.skill-notice{border-left:3px solid #39865b;padding:10px;overflow-wrap:anywhere}.category-editor{border:1px solid #8884;border-radius:10px;padding:16px;display:grid;gap:8px}.category-line label{display:flex;align-items:center;gap:10px;flex:1}.category-line input{width:100%}.reference-file{border-top:1px solid #8883;padding-top:10px}.reference-file summary{cursor:pointer;font-size:11px;overflow-wrap:anywhere}.reference-file summary label{display:flex;align-items:start}.reference-file small{display:block;opacity:.6}.diff-columns{display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:11px;min-width:0}.diff-columns>div{min-width:0}.diff-columns pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;border:1px solid #8883;padding:8px}.skill-editor h2{font-size:15px;overflow-wrap:anywhere;margin:0}.skill-editor h3,.skill-editor p{font-size:12px;margin:0;line-height:1.5}.skills-manager :focus-visible{outline:2px solid currentColor;outline-offset:3px}@media(max-width:950px){.skill-layout{grid-template-columns:1fr}.skill-editor{position:static;grid-row:1}.skills-manager{padding:16px}.diff-columns{grid-template-columns:1fr}.category-line label{flex-wrap:wrap}}
</style>
