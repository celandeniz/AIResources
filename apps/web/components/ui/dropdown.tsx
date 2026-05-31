'use client';
import * as React from 'react';
import * as DM from '@radix-ui/react-dropdown-menu';
import { cn } from '../../lib/utils';

export const Dropdown = DM.Root;
export const DropdownTrigger = DM.Trigger;

export function DropdownContent({ children, className, align = 'end' }: { children: React.ReactNode; className?: string; align?: 'start' | 'end' | 'center' }) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        sideOffset={6}
        className={cn('z-50 min-w-[12rem] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg animate-fade-up', className)}
      >
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function DropdownItem({ children, className, ...props }: React.ComponentPropsWithoutRef<typeof DM.Item>) {
  return (
    <DM.Item
      className={cn('relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none transition-colors focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50', className)}
      {...props}
    >
      {children}
    </DM.Item>
  );
}

export const DropdownLabel = ({ children }: { children: React.ReactNode }) => (
  <DM.Label className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground">{children}</DM.Label>
);
export const DropdownSeparator = () => <DM.Separator className="my-1 h-px bg-border" />;
