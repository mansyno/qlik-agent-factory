import { Cpu, Wifi, WifiOff } from 'lucide-react'
import ModelToggle from './ModelToggle'

export default function Header({ isRunning, connected }) {
    return (
        <header style={{
            borderBottom: '1px solid var(--color-border)',
            padding: '0 24px',
            height: 60,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--color-surface)',
            position: 'sticky',
            top: 0,
            zIndex: 50,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                    width: 36, height: 36, borderRadius: 8,
                    background: 'linear-gradient(135deg, #2f81f7, #8b5cf6)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: '0 0 20px rgba(47,129,247,0.3)'
                }}>
                    <Cpu size={18} color="white" />
                </div>
                <div>
                    <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.3px' }}>
                        Qlik Agent Factory
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>Command Center</div>
                </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                {isRunning && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{
                            width: 8, height: 8, borderRadius: '50%',
                            background: 'var(--color-success)',
                            boxShadow: '0 0 8px var(--color-success)',
                            animation: 'pulse-glow 1.5s ease-in-out infinite'
                        }} />
                        <span style={{ fontSize: 12, color: 'var(--color-success)', fontWeight: 600 }}>RUNNING</span>
                    </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: connected ? 'var(--color-success)' : 'var(--color-error)', fontSize: 12 }}>
                    {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
                    {connected ? 'Live' : 'Disconnected'}
                </div>
                <div style={{ marginLeft: 8, paddingLeft: 16, borderLeft: '1px solid var(--color-border)', height: 24, display: 'flex', alignItems: 'center' }}>
                    <ModelToggle />
                </div>
            </div>
        </header>
    )
}
