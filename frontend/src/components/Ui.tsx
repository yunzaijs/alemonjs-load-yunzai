import { Button, Modal, NotificationDiv, PrimaryDiv } from '@alemonjs/react-ui';
import type { ReactNode } from 'react';

export function Feedback({ kind = 'info', children }: { kind?: 'info' | 'success' | 'error' | 'warning'; children: ReactNode }) {
  const styles = {
    info: 'feedback-info',
    success: 'feedback-success',
    error: 'feedback-error',
    warning: 'feedback-warning'
  };

  return <NotificationDiv className={`rounded-xl px-3.5 py-2.5 text-sm ${styles[kind]} animate-fade-in`}>{children}</NotificationDiv>;
}

export function EmptyState({ icon, title, description, action }: { icon?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <PrimaryDiv className='empty-state rounded-xl px-4 py-8 text-center'>
      {icon && <div className='text-2xl mb-2'>{icon}</div>}
      <div className='text-sm font-medium'>{title}</div>
      {description && <div className='text-xs opacity-50 mt-1'>{description}</div>}
      {action && <div className='mt-4'>{action}</div>}
    </PrimaryDiv>
  );
}

export function ConfirmDialog({ open, title, description, confirmLabel = '确认', onClose, onConfirm }: { open: boolean; title: string; description: string; confirmLabel?: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal isOpen={open} onClose={onClose}>
      <div className='p-5 space-y-4 max-w-sm'>
        <div className='text-base font-semibold'>{title}</div>
        <div className='text-sm opacity-65 leading-relaxed'>{description}</div>
        <div className='flex gap-2.5 justify-end'>
          <Button className='px-4 py-2 rounded-xl text-sm' onClick={onClose}>取消</Button>
          <Button className='px-4 py-2 rounded-xl text-sm font-semibold bg-red-500/15 hover:bg-red-500/25 text-red-500' onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}
