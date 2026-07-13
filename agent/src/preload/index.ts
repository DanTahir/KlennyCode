import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { KlennyApi } from '@shared/ipc'
import type { AgentStreamEvent, UpdateStatusEvent } from '@shared/types'

const api: KlennyApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  setApiKey: (key) => ipcRenderer.invoke(IPC.setApiKey, key),
  clearApiKey: () => ipcRenderer.invoke(IPC.clearApiKey),

  openWorkspace: () => ipcRenderer.invoke(IPC.workspaceOpen),
  getWorkspace: () => ipcRenderer.invoke(IPC.workspaceGet),

  listModels: (force) => ipcRenderer.invoke(IPC.modelsList, force),
  listShells: () => ipcRenderer.invoke(IPC.shellsList),

  listTabs: () => ipcRenderer.invoke(IPC.tabsList),
  createTab: () => ipcRenderer.invoke(IPC.tabCreate),
  closeTab: (tabId) => ipcRenderer.invoke(IPC.tabClose, tabId),
  setTabMode: (tabId, mode) => ipcRenderer.invoke(IPC.tabSetMode, tabId, mode),
  setTabModel: (tabId, model) => ipcRenderer.invoke(IPC.tabSetModel, tabId, model),

  listHistory: () => ipcRenderer.invoke(IPC.historyList),
  reopenHistory: (tabId) => ipcRenderer.invoke(IPC.historyReopen, tabId),
  deleteHistory: (tabId) => ipcRenderer.invoke(IPC.historyDelete, tabId),

  sendMessage: (payload) => ipcRenderer.invoke(IPC.sendMessage, payload),
  stopGeneration: (tabId) => ipcRenderer.invoke(IPC.stopGeneration, tabId),

  resolveApproval: (actionId, decision) => ipcRenderer.invoke(IPC.resolveApproval, actionId, decision),
  resolveQuestion: (questionId, answers) => ipcRenderer.invoke(IPC.resolveQuestion, questionId, answers),

  listSkills: () => ipcRenderer.invoke(IPC.skillsList),
  readSkill: (path) => ipcRenderer.invoke(IPC.skillRead, path),
  writeSkill: (name, scope, description, body) =>
    ipcRenderer.invoke(IPC.skillWrite, name, scope, description, body),

  listSubagentTypes: () => ipcRenderer.invoke(IPC.subagentsList),
  writeSubagentType: (name, scope, description, tools, model, body) =>
    ipcRenderer.invoke(IPC.subagentWrite, name, scope, description, tools, model, body),

  listPlans: () => ipcRenderer.invoke(IPC.plansList),
  readPlan: (slug) => ipcRenderer.invoke(IPC.planRead, slug),

  readMemory: (scope) => ipcRenderer.invoke(IPC.memoryRead, scope),
  writeMemory: (scope, content) => ipcRenderer.invoke(IPC.memoryWrite, scope, content),

  revertCheckpoint: (id) => ipcRenderer.invoke(IPC.checkpointRevert, id),

  setPineconeKey: (key) => ipcRenderer.invoke(IPC.pineconeSetKey, key),
  clearPineconeKey: () => ipcRenderer.invoke(IPC.pineconeClearKey),
  rebuildIndex: () => ipcRenderer.invoke(IPC.indexRebuild),
  deleteIndex: () => ipcRenderer.invoke(IPC.indexDelete),
  getIndexStatus: () => ipcRenderer.invoke(IPC.indexStatus),

  getAppVersion: () => ipcRenderer.invoke(IPC.appVersion),
  isUpdateSupported: () => ipcRenderer.invoke(IPC.updateSupported),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),

  onStreamEvent: (cb) => {
    const listener = (_: unknown, event: AgentStreamEvent) => cb(event)
    ipcRenderer.on('agent:stream', listener)
    return () => ipcRenderer.removeListener('agent:stream', listener)
  },
  onUpdateStatus: (cb) => {
    const listener = (_: unknown, event: UpdateStatusEvent) => cb(event)
    ipcRenderer.on('app:updateStatus', listener)
    return () => ipcRenderer.removeListener('app:updateStatus', listener)
  }
}

contextBridge.exposeInMainWorld('klenny', api)

declare global {
  interface Window {
    klenny: KlennyApi
  }
}
