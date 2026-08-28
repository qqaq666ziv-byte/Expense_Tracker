// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from './app/state';
import { TUTORIAL_STORAGE_KEY, startTutorial } from './app/tutorial';
import App from './App';
import { ThemeProvider } from './context/ThemeContext';

const financeAppMock = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('./app/useFinanceApp', () => ({
  useFinanceApp: () => financeAppMock.current,
}));

function financeAppFor(ownerId: string) {
  return {
    state: createInitialState(ownerId),
    user: { email: `${ownerId}@example.com` },
    authLoading: false,
    cloudEnabled: false,
    syncBusy: false,
    syncReport: undefined,
    unresolvedSyncRecordKeys: new Set<string>(),
    mutationLockedRecordKeys: new Set<string>(),
    transferDependencyConflictIds: new Set<string>(),
    transferMutationsEnabled: true,
    conflictResolutionImpact: new Map<string, number>(),
    storageError: false,
    storageRecovery: null,
    guestImportNotice: '',
    legacyBootstrapNotice: '',
    safetyNotice: '',
    hasSeparateGuestData: false,
    dismissGuestImport: vi.fn(),
    importGuestData: vi.fn(),
    importLegacyCandidate: vi.fn(),
    keepCloudData: vi.fn(),
    setData: vi.fn(),
    put: vi.fn(() => true),
    categoryLifecycle: vi.fn(() => true),
    archiveAccount: vi.fn(() => true),
    releaseGoalAllocations: vi.fn(() => true),
    softDelete: vi.fn(() => true),
    confirmTransferAccounts: vi.fn(() => true),
    acceptRemoteConflict: vi.fn(),
    syncNow: vi.fn(async () => undefined),
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('shiba-finance:onboarding:v1', 'completed');
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App owner boundary', () => {
  it('preserves the owner-independent tab while discarding the previous owner Assets draft', async () => {
    const user = userEvent.setup();
    financeAppMock.current = financeAppFor('owner-a');
    const view = render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole('button', { name: '資產' }));
    expect(await screen.findByRole('heading', { name: '資產分配' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新增帳戶' }));
    await user.type(screen.getByRole('textbox', { name: '帳戶名稱' }), 'A 的未儲存帳戶');

    financeAppMock.current = financeAppFor('owner-b');
    view.rerender(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );

    expect(await screen.findByRole('heading', { name: '資產分配' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('A 的未儲存帳戶')).not.toBeInTheDocument();
  });

  it('keeps Settings open without reusing owner A tutorial progress for owner B', async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      `${TUTORIAL_STORAGE_KEY}:user:owner-a`,
      JSON.stringify({ ...startTutorial('first-record'), status: 'paused' }),
    );
    financeAppMock.current = financeAppFor('owner-a');
    const view = render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole('button', { name: /帳戶與同步/ }));
    await user.click(screen.getByRole('button', { name: /設定與說明/ }));
    expect(await screen.findByRole('button', { name: '繼續上次進度' })).toBeInTheDocument();

    financeAppMock.current = financeAppFor('owner-b');
    view.rerender(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );

    expect(screen.getByRole('heading', { name: '設定與說明' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '繼續上次進度' })).not.toBeInTheDocument();
  });
});
