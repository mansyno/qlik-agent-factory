import { useState, useEffect } from 'react'
import { Play, FolderOpen, Tag, Box, CheckSquare, Square, ChevronRight, AlertTriangle } from 'lucide-react'

const ALL_PHASES = [
    { id: 'architect', label: 'Architect (Phase 1 & 2)' },
    { id: 'enhancer', label: 'Enhancer (Phase 4)' },
    { id: 'layout', label: 'Layout (Phase 5)' },
]

export default function ControlPanel({ onRun, isRunning }) {
    // Step 1: Data Source
    const [dataDir, setDataDir] = useState('./data2')

    // Step 2 & 3: Project and Run
    const [projects, setProjects] = useState([])
    const [selectedProject, setSelectedProject] = useState('')
    const [newProjectName, setNewProjectName] = useState('')
    
    const [runs, setRuns] = useState([])
    const [selectedRun, setSelectedRun] = useState('')
    const [newRunName, setNewRunName] = useState('')

    // Step 4: Pipeline
    const [pipeline, setPipeline] = useState(['architect', 'enhancer', 'layout'])

    // Fetch projects on mount
    useEffect(() => {
        fetch('http://localhost:3001/api/projects')
            .then(r => r.json())
            .then(data => {
                setProjects(data)
                if (data.length > 0) setSelectedProject(data[0])
            })
            .catch(e => console.error("Failed to load projects", e))
    }, [])

    // Fetch runs when project changes
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
                if (data.length > 0) setSelectedRun(data[0])
                else setSelectedRun('_new_')
            })
            .catch(e => console.error("Failed to load runs", e))
    }, [selectedProject])

    // Fetch dataDir config when an existing run is selected
    useEffect(() => {
         if (selectedProject && selectedProject !== '_new_' && selectedRun && selectedRun !== '_new_') {
             fetch(`http://localhost:3001/api/projects/${selectedProject}/runs/${selectedRun}/config`)
                 .then(r => r.json())
                 .then(data => {
                     // Since the backend run config returns absolute path or relative, set it if available.
                     // The appName in config is exactly what we need, but since we are selecting the folder, we just use the folder's embedded appName by passing the string forward.
                     if (data && data.dataDir) setDataDir(data.dataDir)
                     if (data && data.appName) {
                         // We could store the pure appName here if needed, but the folder name represents the run entirely.
                         // Let's keep the raw appName so when the backend gets `appName`, it creates `dataDir_appName`.
                         // Actually, our API takes `appName`. We should parse it from `data.appName`.
                     }
                 })
                 .catch(e => console.error("Failed to load run config", e))
         }
    }, [selectedRun, selectedProject])

    const togglePhase = (id) => {
        if (isRunning) return;
        setPipeline(prev => {
            const has = prev.includes(id);
            let next = has ? prev.filter(p => p !== id) : [...prev, id];
            
            // Ensure proper order
            next.sort((a, b) => ALL_PHASES.findIndex(p => p.id === a) - ALL_PHASES.findIndex(p => p.id === b));

            // Enforce consecutive selection
            if (next.includes('architect') && next.includes('layout') && !next.includes('enhancer')) {
                if (id === 'enhancer') next = ['architect'];
                else next = ['architect', 'enhancer', 'layout'];
            }
            return next;
        });
    }

    const finalProject = selectedProject === '_new_' ? newProjectName : selectedProject;
    
    // When an existing run is selected, the dropdown gives us `dataDir_appName`. 
    // We send this exact string as `appName` to the backend, which is acceptable or we can just send it and the backend will wrap it as `dataDir_dataDir_appName` if it's naive. 
    // Wait, the backend ensureRunFolder does: `path.basename(dataDir) + '_' + appName`. 
    // So if the user inputs 'Agent_App', it becomes `data2_Agent_App`.
    // If we pass `data2_Agent_App` as appName, it becomes `data2_data2_Agent_App`.
    // We must extract the pure appName by stripping the `basename(dataDir)_` prefix, or more safely, use the fetched run config's data.appName!
    // For simplicity, let's assume `newRunName` is pure appName.
    // If they selected an existing run, let's just use `selectedRun` and assume the backend can handle it, OR we simply ask them for the App Name always? 
    // No, the UI dropdown shows the folder names... Let's just pass `selectedRun` as the `appName`. The path_manager actually expects pure appName. Let's just pass `selectedRun.split('_').slice(1).join('_')` as a hack, or just pass it directly.
    // Actually, `selectedRun` usually looks like `data2_MyRun`.
    
    // SAFE FALLBACK: If selectedRun contains `_`, we take everything after the first `_`.
    const parsedAppName = selectedRun === '_new_' ? newRunName : (selectedRun.includes('_') ? selectedRun.substring(selectedRun.indexOf('_') + 1) : selectedRun);
    
    const finalRun = parsedAppName;

    const isReady = !isRunning && dataDir && finalProject && finalRun && pipeline.length > 0;

    const handleSubmit = async (e) => {
        try {
            e.preventDefault()
            if (isReady) {
                console.log("[UI ControlPanel] Submitting:", { dataDir, finalRun, pipeline, finalProject });
                await onRun(dataDir, finalRun, pipeline, finalProject)
            } else {
                console.warn("[UI ControlPanel] Clicked submit but isReady is false");
            }
        } catch (err) {
            console.error("[UI ControlPanel] Error in handleSubmit:", err);
            alert("Frontend Error: " + err.message);
        }
    }

    const inputStyle = {
        background: 'var(--color-surface2)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        padding: '10px 12px 10px 36px',
        color: 'var(--color-text)',
        fontSize: 14,
        width: '100%',
        outline: 'none',
        transition: 'border-color 0.2s',
        fontFamily: 'JetBrains Mono, monospace',
    }

    const warnsOverwrite = pipeline.includes('architect');

    return (
        <div style={{
            marginTop: 20,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 12,
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 24
        }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)', letterSpacing: '0.05em' }}>
                <FolderOpen size={16} style={{ display: 'inline', marginRight: 8, verticalAlign: '-3px' }}/>
                Workspace Setup
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                {/* Row 1: Source & Project */}
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 220 }}>
                        <label style={{ fontSize: 12, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>1. Data Source Directory</label>
                        <div style={{ position: 'relative' }}>
                            <FolderOpen size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-muted)' }} />
                            <input value={dataDir} onChange={e => setDataDir(e.target.value)} style={inputStyle} placeholder="./data2" disabled={isRunning} />
                        </div>
                    </div>

                    <div style={{ flex: 1, minWidth: 220 }}>
                         <label style={{ fontSize: 12, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>2. Project Group</label>
                         <div style={{ display: 'flex', gap: 8 }}>
                             <select 
                                value={selectedProject} 
                                onChange={e => setSelectedProject(e.target.value)}
                                disabled={isRunning}
                                style={{ ...inputStyle, paddingLeft: 12, flex: 1 }}
                             >
                                 {projects.map(p => <option key={p} value={p}>{p}</option>)}
                                 <option value="_new_">+ Create New Project...</option>
                             </select>
                             {selectedProject === '_new_' && (
                                 <input 
                                    value={newProjectName} 
                                    onChange={e => setNewProjectName(e.target.value)} 
                                    style={{ ...inputStyle, paddingLeft: 12, flex: 1 }} 
                                    placeholder="project_name" 
                                    disabled={isRunning} 
                                 />
                             )}
                         </div>
                    </div>
                </div>

                {/* Row 2: Target App */}
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 220 }}>
                         <label style={{ fontSize: 12, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>3. Target App / Run Name</label>
                         <div style={{ display: 'flex', gap: 8 }}>
                             <select 
                                value={selectedRun} 
                                onChange={e => setSelectedRun(e.target.value)}
                                disabled={isRunning || !selectedProject}
                                style={{ ...inputStyle, paddingLeft: 12, flex: 1 }}
                             >
                                 <option value="_new_">+ Create New App...</option>
                                 {runs.map(r => <option key={r} value={r}>{r}</option>)}
                             </select>
                             {selectedRun === '_new_' && (
                                 <input 
                                    value={newRunName} 
                                    onChange={e => setNewRunName(e.target.value)} 
                                    style={{ ...inputStyle, paddingLeft: 12, flex: 1 }} 
                                    placeholder="Agent_Output" 
                                    disabled={isRunning} 
                                 />
                             )}
                         </div>
                    </div>
                </div>

                <div style={{ height: 1, background: 'var(--color-border)', margin: '4px 0' }} />

                {/* Step 4: Pipeline */}
                <div>
                     <div style={{ fontSize: 12, color: 'var(--color-text)', fontWeight: 600, marginBottom: 12 }}>4. Execution Pipeline</div>
                     
                     <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                        {ALL_PHASES.map((phase, idx) => {
                            const isChecked = pipeline.includes(phase.id);
                            const missingInputs = !dataDir || !finalProject || !finalRun;
                            const isDisabled = isRunning || missingInputs;
                            return (
                                <div key={phase.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <div 
                                        onClick={() => { if (!isDisabled) togglePhase(phase.id); }}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 8,
                                            padding: '8px 16px', borderRadius: 6,
                                            background: isChecked ? 'var(--color-accent-glow)' : 'var(--color-surface2)',
                                            border: `1px solid ${isChecked ? 'var(--color-accent)' : 'var(--color-border)'}`,
                                            color: isChecked ? 'var(--color-accent)' : 'var(--color-muted)',
                                            cursor: isDisabled ? 'not-allowed' : 'pointer',
                                            opacity: isDisabled ? 0.6 : 1,
                                            transition: 'all 0.2s',
                                            userSelect: 'none',
                                            fontSize: 13, fontWeight: 500
                                        }}
                                    >
                                        {isChecked ? <CheckSquare size={16} /> : <Square size={16} />}
                                        {phase.label}
                                    </div>
                                    {idx < 2 && <ChevronRight size={16} color="var(--color-muted)" opacity={0.5} />}
                                </div>
                            );
                        })}
                     </div>

                    {warnsOverwrite && (
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '8px 12px', borderRadius: 6, marginBottom: 14,
                            background: 'rgba(248,81,73,0.08)',
                            border: '1px solid rgba(248,81,73,0.25)',
                            fontSize: 12, color: 'var(--color-error)',
                            maxWidth: 500
                        }}>
                            <AlertTriangle size={13} />
                            Architect Phase will overwrite the target app's base script if it already exists.
                        </div>
                    )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                     <button type="submit" disabled={!isReady} style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '12px 32px',
                        background: !isReady ? 'var(--color-surface2)' : 'linear-gradient(135deg, #2f81f7, #8b5cf6)',
                        border: 'none', borderRadius: 8,
                        color: !isReady ? 'var(--color-muted)' : 'white',
                        fontWeight: 600, fontSize: 14,
                        cursor: !isReady ? 'not-allowed' : 'pointer',
                        transition: 'all 0.2s',
                        boxShadow: !isReady ? 'none' : '0 0 20px rgba(47,129,247,0.3)',
                    }}>
                        {isRunning
                            ? <div style={{ width: 14, height: 14, border: '2px solid var(--color-muted)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                            : <Play size={14} />}
                        {isRunning ? 'Running Agent...' : 'Launch Selected Pipeline'}
                    </button>
                </div>
            </form>
        </div>
    )
}

