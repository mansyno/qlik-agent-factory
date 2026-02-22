import { Database, Calendar, Key, Hash } from 'lucide-react'

function getFieldIcon(name) {
    const l = name.toLowerCase()
    if (l.includes('date') || l.includes('time')) return <Calendar size={11} color="#f97316" />
    if (l.startsWith('%key') || l.endsWith('_id') || l === 'id') return <Key size={11} color="#2f81f7" />
    return <Database size={11} color="#8b949e" />
}

function TableCard({ name, profile }) {
    const fields = profile.fields || []
    const dateFields = fields.filter(f => f.name.toLowerCase().includes('date') || f.name.toLowerCase().includes('time'))
    const maxCard = fields.length > 0 ? Math.max(...fields.map(f => f.distinctCount || 0)) : 0

    return (
        <div style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 10,
            padding: 16,
            transition: 'border-color 0.2s, box-shadow 0.2s',
        }}
            onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'var(--color-accent)'
                e.currentTarget.style.boxShadow = '0 0 0 1px var(--color-accent-glow)'
            }}
            onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'var(--color-border)'
                e.currentTarget.style.boxShadow = 'none'
            }}
        >
            {/* Table name */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)', fontFamily: 'JetBrains Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '80%' }}>
                    {name.replace(/^.*?-\s*/, '')}
                </span>
                <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 99, background: 'rgba(63,185,80,0.15)', color: 'var(--color-success)', fontWeight: 600, flexShrink: 0 }}>
                    Loaded
                </span>
            </div>

            {/* Stats */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
                <Stat label="Fields" value={fields.length} />
                <Stat label="Max Cardinality" value={maxCard.toLocaleString()} />
                {dateFields.length > 0 && <Stat label="Dates" value={dateFields.length} color="var(--color-warning)" />}
            </div>

            {/* Fields preview */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {fields.slice(0, 8).map(f => (
                    <div key={f.name} style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '2px 7px', borderRadius: 4,
                        background: 'var(--color-surface2)',
                        fontSize: 11, color: 'var(--color-muted)',
                        fontFamily: 'JetBrains Mono, monospace',
                    }}>
                        {getFieldIcon(f.name)}
                        {f.name}
                        <span style={{ color: 'var(--color-border)', fontSize: 10 }}>{f.distinctCount}</span>
                    </div>
                ))}
                {fields.length > 8 && (
                    <div style={{ padding: '2px 7px', borderRadius: 4, background: 'var(--color-surface2)', fontSize: 11, color: 'var(--color-muted)' }}>
                        +{fields.length - 8} more
                    </div>
                )}
            </div>
        </div>
    )
}

function Stat({ label, value, color }) {
    return (
        <div>
            <div style={{ fontSize: 10, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: color || 'var(--color-text)', lineHeight: 1.2 }}>{value}</div>
        </div>
    )
}

export default function ModelArtifacts({ profiles }) {
    const tables = Object.entries(profiles || {})

    return (
        <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 }}>
                Model Artifacts — {tables.length} tables
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
                {tables.map(([name, profile]) => (
                    <TableCard key={name} name={name} profile={profile} />
                ))}
            </div>
        </div>
    )
}
