#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asarModules } from './asar.mjs'

const packageName = '@deepseek-ai/dsh-client-ui-model-selection'
const supportedVersions = ['0.2.2-rc.3', '0.2.2-rc.5']
const begin = '# dsh-model-sync selector: begin'
const end = '# dsh-model-sync selector: end'

function replaceOnce(source, anchor, replacement) {
  if (source.indexOf(anchor) < 0 || source.indexOf(anchor) !== source.lastIndexOf(anchor)) {
    throw new Error('官方模型选择器的实现已变化，已停止生成适配层。')
  }
  return source.replace(anchor, () => replacement)
}

/** Leave native state, current choice, reasoning and selection RPCs intact. */
export function patchNativeSelector(source) {
  source = replaceOnce(source, 'var exports=module.exports;', `var exports=module.exports;
globalThis.__dshModelSyncSelectorVersion=1;
const modelSyncDefault=new Set();
const modelSyncSnapshot=()=>globalThis.__dshModelSyncHidden??modelSyncDefault;
const modelSyncSubscribe=(callback)=>{
  window.addEventListener('dsh-model-sync:visibility',callback);
  return ()=>window.removeEventListener('dsh-model-sync:visibility',callback);
};
const modelSyncVisible=(hidden,provider,id)=>!hidden.has(JSON.stringify([provider,id]));
`)
  source = replaceOnce(source,
    'const showSearch=choices.length>4;const filteredGroups=(0,react.useMemo)(()=>groups.map',
    `const hiddenModels=(0,react.useSyncExternalStore)(modelSyncSubscribe,modelSyncSnapshot,modelSyncSnapshot);
const selectableGroups=(0,react.useMemo)(()=>groups.map(group=>({...group,models:group.models.filter(model=>modelSyncVisible(hiddenModels,group.id,model.id))})),[groups,hiddenModels]);
const showSearch=selectableGroups.reduce((count,group)=>count+group.models.length,0)>4;
const filteredGroups=(0,react.useMemo)(()=>selectableGroups.map`)
  source = replaceOnce(source, '[groups,query,showSearch]', '[selectableGroups,query,showSearch]')
  source = replaceOnce(source, 'function optionsOf(directory,t){const rows=[];', 'function optionsOf(directory,t){const rows=[];const hiddenModels=modelSyncSnapshot();')
  source = replaceOnce(source, 'for(const model of group.models)rows.push({id:rowId(group.id,model.id)',
    'for(const model of group.models.filter(model=>modelSyncVisible(hiddenModels,group.id,model.id)))rows.push({id:rowId(group.id,model.id)')
  return source
}

async function main() {
  const [action, profile = 'desktop'] = process.argv.slice(2)
  if (!['--apply', '--remove'].includes(action) || !/^[a-zA-Z0-9][\w-]*$/.test(profile)) {
    throw new Error('用法：node scripts/selector-overlay.mjs --apply|--remove [profile]')
  }
  const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', profile)
  const patchPath = join(dir, 'cordis.patch.yml')
  const original = await readFile(patchPath, 'utf8')
  const start = original.indexOf(begin)
  const stop = original.indexOf(end)
  if ((start < 0) !== (stop < 0) || (start >= 0 && stop < start)) throw new Error('现有适配层标记不完整。')
  const base = start === -1 ? original : original.slice(0, start) + original.slice(stop + end.length).replace(/^\n/, '')
  const overlayPath = join(dir, 'model-sync-selector')
  let next = base
  let version
  if (action === '--apply') {
    if (/^\s*-\s*id:\s*['"]?(?:ui-model-selection|model-sync-ui-model-selection)['"]?\s*$/m.test(base)) {
      throw new Error('当前 profile 已单独调整官方模型选择器，已保留它的配置。')
    }
    const upstream = join(asarModules(), packageName)
    const manifest = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8'))
    version = manifest.version
    if (!supportedVersions.includes(version)) {
      throw new Error(`当前适配层支持 DSH ${supportedVersions.join('、')}，发现 ${version}。`)
    }
    const client = patchNativeSelector(await readFile(join(upstream, manifest.exports['./client'].default), 'utf8'))
    await mkdir(overlayPath, { recursive: true })
    await writeFile(join(overlayPath, 'package.json'), JSON.stringify({
      name: packageName,
      version: manifest.version,
      type: 'module',
      exports: { '.': './index.js', './client': './client.js' },
      dsh: { client: manifest.dsh.client },
    }, null, 2) + '\n')
    await writeFile(join(overlayPath, 'index.js'), readFileSync(join(upstream, manifest.exports['.'].default)))
    await writeFile(join(overlayPath, 'client.js'), client)
    next = base.trim() === '[]' ? '' : base.trimEnd() + '\n\n'
    next += [begin, '- id: ui-model-selection', `  name: '${packageName}'`, '  disabled: true',
      '- insert:', '    - id: model-sync-ui-model-selection', `      name: ${JSON.stringify(join(overlayPath, 'index.js'))}`, end, ''].join('\n')
  }
  if (next.trim() === '') next = '[]\n'
  if (original !== next) {
    const temporary = `${patchPath}.model-sync-${process.pid}.tmp`
    if (await readFile(patchPath, 'utf8') !== original) throw new Error('profile 配置已变化，请重新执行。')
    await writeFile(temporary, next, { mode: 0o600 })
    await rename(temporary, patchPath)
  }
  console.log(action === '--apply' ? `已为 ${profile} 安装 DSH ${version} 原生选择器适配。` : `已为 ${profile} 恢复原生选择器加载配置。`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
