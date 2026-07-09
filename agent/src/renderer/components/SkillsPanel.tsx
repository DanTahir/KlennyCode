import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

export function SkillsPanel() {
  const { skills, setSkills } = useAppStore()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [scope, setScope] = useState<'project' | 'global'>('project')

  useEffect(() => {
    void window.klenny.listSkills().then(setSkills)
  }, [])

  const save = async () => {
    if (!name.trim()) return
    await window.klenny.writeSkill(name.trim(), scope, description, body)
    setSkills(await window.klenny.listSkills())
    setName('')
    setDescription('')
    setBody('')
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl space-y-4">
      <h2 className="text-xl font-semibold">Skills</h2>
      <p className="text-sm text-klenny-muted">
        Cursor-style skills are auto-discovered. Klenny reads the catalog and loads full instructions when relevant.
      </p>
      <ul className="space-y-2">
        {skills.map((s) => (
          <li key={s.path} className="border border-klenny-border rounded p-3 text-sm">
            <div className="font-medium">{s.name} <span className="text-klenny-muted">({s.scope})</span></div>
            <div className="text-klenny-muted">{s.description}</div>
          </li>
        ))}
      </ul>
      <div className="border border-klenny-border rounded p-4 space-y-2">
        <h3 className="font-medium">Create skill</h3>
        <input className="w-full px-2 py-1 bg-klenny-bg border border-klenny-border rounded" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="w-full px-2 py-1 bg-klenny-bg border border-klenny-border rounded" placeholder="description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <select className="w-full px-2 py-1 bg-klenny-bg border border-klenny-border rounded" value={scope} onChange={(e) => setScope(e.target.value as 'project' | 'global')}>
          <option value="project">Project</option>
          <option value="global">Global</option>
        </select>
        <textarea className="w-full min-h-[120px] px-2 py-1 bg-klenny-bg border border-klenny-border rounded" placeholder="Skill instructions (markdown)" value={body} onChange={(e) => setBody(e.target.value)} />
        <button className="px-3 py-1 rounded bg-klenny-accent text-black text-sm" onClick={() => void save()}>Save skill</button>
      </div>
    </div>
  )
}
