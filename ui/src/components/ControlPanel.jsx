import { useState } from 'react'
import { Play, FolderOpen, Tag } from 'lucide-react'

export default function ControlPanel({ onRun, isRunning }) {
    const [dataDir, setDataDir] = useState('./data2')
    const [appName, setAppName] = useState('Agent_Output')

    const handleSubmit = (e) => {
        e.preventDefault()
        if (!isRunning && dataDir && appName) onRun(dataDir, appName)
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

    return (
        <div style={{
            marginTop: 20,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 12,
            padding: '20px 24px',
        }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>
                Control Panel
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                    <label style={{ fontSize: 12, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>Data Directory</label>
                    <div style={{ position: 'relative' }}>
                        <FolderOpen size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-muted)' }} />
                        <input value={dataDir} onChange={e => setDataDir(e.target.value)} style={inputStyle} placeholder="./data2" disabled={isRunning} />
                    </div>
                </div>

                <div style={{ flex: 1, minWidth: 220 }}>
                    <label style={{ fontSize: 12, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>App Name</label>
                    <div style={{ position: 'relative' }}>
                        <Tag size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-muted)' }} />
                        <input value={appName} onChange={e => setAppName(e.target.value)} style={inputStyle} placeholder="Agent_Output" disabled={isRunning} />
                    </div>
                </div>

                <button type="submit" disabled={isRunning} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 24px',
                    background: isRunning ? 'var(--color-surface2)' : 'linear-gradient(135deg, #2f81f7, #8b5cf6)',
                    border: 'none', borderRadius: 8,
                    color: isRunning ? 'var(--color-muted)' : 'white',
                    fontWeight: 600, fontSize: 14,
                    cursor: isRunning ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s',
                    boxShadow: isRunning ? 'none' : '0 0 20px rgba(47,129,247,0.3)',
                    whiteSpace: 'nowrap',
                    height: 42,
                }}>
                    {isRunning ? (
                        <div style={{ width: 14, height: 14, border: '2px solid var(--color-muted)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                    ) : (
                        <Play size={14} />
                    )}
                    {isRunning ? 'Running...' : 'Run Job'}
                </button>
            </form>
        </div>
    )
}
