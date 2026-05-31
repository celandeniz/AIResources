'use client';
import { Toaster as Sonner } from 'sonner';
import { useTheme } from 'next-themes';

export function Toaster() {
  const { theme } = useTheme();
  return (
    <Sonner
      theme={(theme as 'light' | 'dark') ?? 'light'}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'group rounded-xl border border-border bg-popover text-popover-foreground shadow-lg font-sans text-sm',
          description: 'text-muted-foreground',
        },
      }}
    />
  );
}

export { toast } from 'sonner';
