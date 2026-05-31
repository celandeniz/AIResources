'use client';
import * as React from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, PieChart, Pie, Cell } from 'recharts';
import { Card } from './ui/card';
import { cn } from '../lib/utils';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

export function KpiCard({
  label, value, sub, delta, accent, spark,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  delta?: number;
  accent?: 'primary' | 'success' | 'warning' | 'danger';
  spark?: number[];
}) {
  const accentColor =
    accent === 'success' ? 'hsl(var(--success))' :
    accent === 'warning' ? 'hsl(var(--warning))' :
    accent === 'danger' ? 'hsl(var(--danger))' : 'hsl(var(--primary))';
  const data = (spark ?? []).map((y, x) => ({ x, y }));
  return (
    <Card className="relative overflow-hidden p-5">
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        {typeof delta === 'number' && (
          <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium', delta >= 0 ? 'text-success' : 'text-danger')}>
            {delta >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
            {Math.abs(delta)}%
          </span>
        )}
      </div>
      <div className="mt-2 font-display text-3xl tracking-tight tnum">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      {data.length > 1 && (
        <div className="mt-3 h-10">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 2, bottom: 0, left: 0, right: 0 }}>
              <defs>
                <linearGradient id={`g-${label}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={accentColor} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={accentColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="y" stroke={accentColor} strokeWidth={2} fill={`url(#g-${label})`} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

const chartTooltip = {
  contentStyle: { background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 10, fontSize: 12, boxShadow: '0 8px 24px -8px hsl(var(--shadow-color)/0.3)' },
  labelStyle: { color: 'hsl(var(--muted-foreground))' },
};

export function TrendChart({ data, keys }: { data: any[]; keys: { key: string; color: string; label: string }[] }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <defs>
            {keys.map((k) => (
              <linearGradient key={k.key} id={`grad-${k.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={k.color} stopOpacity={0.25} />
                <stop offset="100%" stopColor={k.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} width={36} />
          <Tooltip {...chartTooltip} />
          {keys.map((k) => (
            <Area key={k.key} type="monotone" dataKey={k.key} name={k.label} stroke={k.color} strokeWidth={2} fill={`url(#grad-${k.key})`} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DonutChart({ data }: { data: { name: string; value: number; color: string }[] }) {
  const total = data.reduce((a, b) => a + b.value, 0) || 1;
  return (
    <div className="flex items-center gap-5">
      <div className="relative h-32 w-32">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" innerRadius={42} outerRadius={62} paddingAngle={2} stroke="none">
              {data.map((d, i) => <Cell key={i} fill={d.color} />)}
            </Pie>
            <Tooltip {...chartTooltip} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-xl tnum">{total}</span>
          <span className="text-[10px] uppercase text-muted-foreground">total</span>
        </div>
      </div>
      <div className="space-y-1.5">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-2 text-sm">
            <span className="size-2.5 rounded-sm" style={{ background: d.color }} />
            <span className="text-muted-foreground">{d.name}</span>
            <span className="ml-auto font-mono tnum">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
