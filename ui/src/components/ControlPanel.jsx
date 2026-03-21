import { useState, useEffect } from 'react'
import { Play, FolderOpen, Tag, Box, CheckSquare, Square, ChevronRight, AlertTriangle, ChevronDown } from 'lucide-react'

const ALL_PHASES = [
    { id: 'architect', label: 'Architect (Phase 1 & 2)' },
    { id: 'enhancer', label: 'Enhancer (Phase 4)' },
    { id: 'layout', label: 'Layout (Phase 5)' },
]

export default function ControlPanel({ onRun, isRunning }) {
    const [dataDir, setDataDir] = useState('./data2')
    const [projects, setProjects] = useState([])
    const [selectedProject, setSelectedProject] = useState('')
    const [newProjectName, setNewProjectName] = useState('')
    const [runs, setRuns] = useState([])
    const [selectedRun, setSelectedRun] = useState('')
    const [newRunName, setNewRunName] = useState('')
    const [pipeline, setPipeline] = useState(['architect', 'enhancer', 'layout'])

    useEffect(() => {
        fetch('http://localhost:3001/api/projects')
            .then(r => r.json())
            .then(data => {
                setProjects(data)
                if (data.length > 0) setSelectedProject(data[0])
            })
            .catch(e => console.error("Failed to load projects", e))
    }, [])

    useEffect(() => {
        if (!selectedProject || selectedProject === '_new_') {
            setRuns([])
            setSelectedRun('_new_')
            return
        }
        fetch(`http://localhost:3001/api/projects/${selectedProject}/runs`)
            .then(r => r.json())
            .then(data => {
                setRuns(data)
                if (data.length > 0) {
                    setSelectedRun(prev => data.find(d => d.name === prev) ? prev : data[0].name)
                } else {
                    setSelectedRun('_new_')
                }
            })
            .catch(e => console.error("Failed to load runs", e))
    }, [selectedProject, isRunning])

    useEffect(() => {
         if (selectedProject && selectedProject !== '_new_' && selectedRun && selectedRun !== '_new_') {
             fetch(`http://localhost:3001/api/projects/${selectedProject}/runs/${selectedRun}/config`)
                 .then(r => r.json())
                 .then(data => { if (data && data.dataDir) setDataDir(data.dataDir) })
                 .catch(e => console.error("Failed to load run config", e))
         }
    }, [selectedRun, selectedProject])

    const togglePhase = (id) => {
        if (isRunning) return;
        setPipeline(prev => {
            const has = prev.includes(id);
            let next = has ? prev.filter(p => p !== id) : [...prev, id];
            next.sort((a, b) => ALL_PHASES.findIndex(p => p.id === a) - ALL_PHASES.findIndex(p => p.id === b));
            if (next.includes('architect') && next.includes('layout') && !next.includes('enhancer')) {
                if (id === 'enhancer') next = ['architect'];
                else next = ['architect', 'enhancer', 'layout'];
            }
            return next;
        });
    }

    const finalProject = selectedProject === '_new_' ? newProjectName : selectedProject;
    const finalRun = selectedRun === '_new_' ? newRunName : (selectedRun.includes('_') ? selectedRun.substring(selectedRun.indexOf('_') + 1) : selectedRun);
    const selectedRunObj = runs.find(r => r.name === selectedRun);
    const isCurrentAppMissing = selectedRunObj ? !selectedRunObj.appExists : false;

    useEffect(() => {
        if (isCurrentAppMissing && !pipeline.includes('architect')) {
            setPipeline(prev => {
                const next = ['architect', ...prev.filter(p => p !== 'architect')];
                next.sort((a, b) => ALL_PHASES.findIndex(p => p.id === a) - ALL_PHASES.findIndex(p => p.id === b));
                return next;
            });
        }
    }, [isCurrentAppMissing, pipeline])

    const isReady = !isRunning && dataDir && finalProject && finalRun && pipeline.length > 0;

    const handleSubmit = async (e) => {
        e.preventDefault()
        if (isReady) await onRun(dataDir, finalRun, pipeline, finalProject)
    }

    const handleBrowse = async () => {
        const res = await fetch('http://localhost:3001/api/utils/browse-folder');
        const data = await res.json();
        if (data.path) setDataDir(data.path);
    };

    const inputStyle = {
        background: 'var(--color-surface2)',
        border: '1px solid var(--color-border)',
        borderRadius: 4,
        padding: '4px 8px',
        color: 'var(--color-text)',
        fontSize: 12,
        width: '100%',
        outline: 'none',
        fontFamily: 'JetBrains Mono, monospace',
    }
    const labelStyle = { fontSize: 10, color: 'var(--color-muted)', display: 'block', marginBottom: 2, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text)', textTransform: 'uppercase', letterSpacing: '0.1em', borderBottom: '1px solid var(--color-border)', paddingBottom: 6 }}>
                Workspace Setup
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                    <label style={labelStyle}>1. Data Source</label>
                    <div style={{ display: 'flex', gap: 4 }}>
                        <input value={dataDir} onChange={e => setDataDir(e.target.value)} style={inputStyle} placeholder="./data2" disabled={isRunning} />
                        <button type="button" onClick={handleBrowse} disabled={isRunning} style={{ padding: '0 8px', background: 'var(--color-surface2)', border: '1px solid var(--color-border)', borderRadius: 4, color: 'var(--color-text)', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>
                            ...
                        </button>
                    </div>
                </div>

                <div>
                     <label style={labelStyle}>2. Project Group</label>
                     <div style={{ position: 'relative' }}>
                         <select value={selectedProject} onChange={e => setSelectedProject(e.target.value)} disabled={isRunning} style={{ ...inputStyle, appearance: 'none' }}>
                             {projects.map(p => <option key={p} value={p}>{p}</option>)}
                             <option value="_new_">+ New Project...</option>
                         </select>
                         <ChevronDown size={12} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-muted)', pointerEvents: 'none' }} />
                     </div>
                     {selectedProject === '_new_' && <input value={newProjectName} onChange={e => setNewProjectName(e.target.value)} style={{ ...inputStyle, marginTop: 4 }} placeholder="project_name" disabled={isRunning} />}
                </div>

                <div>
                     <label style={labelStyle}>3. Target App / Run</label>
                     <div style={{ position: 'relative' }}>
                         <select value={selectedRun} onChange={e => setSelectedRun(e.target.value)} disabled={isRunning || !selectedProject} style={{ ...inputStyle, appearance: 'none' }}>
                             <option value="_new_">+ New App...</option>
                             {runs.map(r => <option key={r.name} value={r.name}>{r.name} {!r.appExists ? '⚠️' : ''}</option>)}
                         </select>
                         <ChevronDown size={12} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-muted)', pointerEvents: 'none' }} />
                     </div>
                     {selectedRun === '_new_' && <input value={newRunName} onChange={e => setNewRunName(e.target.value)} style={{ ...inputStyle, marginTop: 4 }} placeholder="Agent_Output" disabled={isRunning} />}
                </div>

                <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
                     <label style={labelStyle}>4. Pipeline</label>
                     <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                        {ALL_PHASES.map((phase) => {
                            const isChecked = pipeline.includes(phase.id);
                            const isDisabled = isRunning || !dataDir || !finalProject || !finalRun || (phase.id === 'architect' && isCurrentAppMissing);
                            return (
                                <div key={phase.id} onClick={() => { if (!isDisabled) togglePhase(phase.id); }} style={{
                                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 4,
                                    background: isChecked ? 'var(--color-accent-glow)' : 'var(--color-surface2)',
                                    border: `1px solid ${isChecked ? 'var(--color-accent)' : 'var(--color-border)'}`,
                                    color: isChecked ? 'var(--color-accent)' : 'var(--color-muted)',
                                    cursor: isDisabled ? 'not-allowed' : 'pointer', opacity: isDisabled ? 0.6 : 1, fontSize: 11, transition: 'all 0.1s'
                                }}>
                                    {isChecked ? <CheckSquare size={12} /> : <Square size={12} />}
                                    {phase.label.split(' (')[0]}
                                </div>
                            );
                        })}
                     </div>
                </div>

                <button type="submit" disabled={!isReady} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px', width: '100%',
                    background: !isReady ? 'var(--color-surface2)' : 'linear-gradient(135deg, #2f81f7, #8b5cf6)',
                    border: 'none', borderRadius: 6, color: !isReady ? 'var(--color-muted)' : 'white', fontWeight: 700, fontSize: 12, cursor: isReady ? 'pointer' : 'not-allowed', transition: 'all 0.2s', boxShadow: !isReady ? 'none' : '0 4px 12px rgba(47,129,247,0.2)'
                }}>
                    {isRunning ? <div style={{ width: 12, height: 12, border: '2px solid var(--color-muted)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /> : <Play size={12} />}
                    {isRunning ? 'Running...' : 'Launch Agent'}
                </button>
            </form>
        </div>
    )
}
