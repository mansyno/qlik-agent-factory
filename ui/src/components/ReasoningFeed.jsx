import { useEffect, useRef } from 'react'
import { Terminal } from 'lucide-react'

const TYPE_COLORS = {
    info: 'var(--color-text)',
    success: 'var(--color-success)',
    warning: 'var(--color-warning)',
    error: 'var(--color-error)',
    reasoning: '#a78bfa',
    phase: 'var(--color-accent)',
}

const AGENT_COLORS = {
    Architect: '#f97316',
    Enhancer: '#a78bfa',
    System: 'var(--color-muted)',
    Server: 'var(--color-muted)',
}

export default function ReasoningFeed({ logs, isRunning }) {
    const bottomRef = useRef(null)

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [logs])

    return (
        <div style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 12,
            display: 'flex',
            flexDirection: 'column',
            height: 500,
        }}>
            {/* Header */}
            <div style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--color-border)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Terminal size={14} color="var(--color-muted)" />
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        Reasoning Feed
                    </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {isRunning && (
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-success)', animation: 'pulse-glow 1s ease-in-out infinite' }} />
                    )}
                    <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>{logs.length} events</span>
                </div>
            </div>

            {/* Log entries */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0', fontFamily: 'JetBrains Mono, monospace' }}>
                {logs.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-muted)', fontSize: 13 }}>
                        Waiting for agent events...
                    </div>
                ) : logs.map((log, i) => (
                    <div key={i} className="animate-fade-in" style={{
                        padding: '4px 16px',
                        display: 'flex',
                        gap: 10,
                        alignItems: 'flex-start',
                        borderLeft: i === logs.length - 1 && isRunning ? `2px solid var(--color-accent)` : '2px solid transparent',
                    }}>
                        <span style={{ color: 'var(--color-muted)', fontSize: 10, whiteSpace: 'nowrap', marginTop: 2, flexShrink: 0 }}>
                            {new Date(log.timestamp).toLocaleTimeString('en-GB', { hour12: false })}
                        </span>
                        <span style={{ color: AGENT_COLORS[log.agent] || 'var(--color-muted)', fontSize: 11, fontWeight: 600, flexShrink: 0, width: 70 }}>
                            {log.agent}
                        </span>
                        <span style={{ color: TYPE_COLORS[log.type] || 'var(--color-text)', fontSize: 12, lineHeight: 1.5, wordBreak: 'break-word' }}>
                            {log.message}
                        </span>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>
        </div>
    )
}
