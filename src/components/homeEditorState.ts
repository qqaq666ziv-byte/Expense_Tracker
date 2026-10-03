import type { AssetAccount, Category, Transaction, Transfer } from '../domain/model';

type TransactionType = Transaction['type'];
type QuickReentryParents = { category?: Category; account?: AssetAccount };
type TransactionSelection = {
  type: TransactionType;
  categoryId: string;
  accountId: string;
};
type TransactionEditor = TransactionSelection & (
  | { kind: 'create-transaction'; quickReentryParents: QuickReentryParents | null }
  | { kind: 'edit-transaction'; record: Transaction }
);

type TransferAccountSelection = { id: string; snapshot?: AssetAccount };
type TransferEditor = {
  // Returning to income/expense keeps its last account, independent of transfer endpoints.
  previousTransactionType: TransactionType;
  previousAccountId: string;
  source: TransferAccountSelection;
  destination: TransferAccountSelection;
} & (
  | { kind: 'create-transfer' }
  | { kind: 'edit-transfer'; record: Transfer }
);

/** A form has one editing identity; parent snapshots exist only in their owning mode. */
export type HomeEditorState = TransactionEditor | TransferEditor;

type HomeEditorAction =
  | { type: 'switch-transaction'; transactionType: TransactionType }
  | { type: 'switch-transfer' }
  | { type: 'edit-transaction'; record: Transaction }
  | { type: 'edit-transfer'; record: Transfer; accounts: readonly AssetAccount[] }
  | { type: 'reset'; accounts: readonly AssetAccount[] }
  | { type: 'restore-picks'; transactionType: TransactionType; categoryId?: string; accountId?: string }
  | { type: 'select-category'; categoryId: string }
  | { type: 'select-account'; accountId: string }
  | { type: 'quick-reentry'; category: Category; account: AssetAccount }
  | { type: 'select-transfer-account'; side: 'source' | 'destination'; account: AssetAccount }
  | { type: 'swap-transfer-accounts' };

export function createHomeEditorState(): HomeEditorState {
  return {
    kind: 'create-transaction', type: 'expense', categoryId: '', accountId: '',
    quickReentryParents: null,
  };
}

export function isTransferEditor(state: HomeEditorState): state is TransferEditor {
  return state.kind === 'create-transfer' || state.kind === 'edit-transfer';
}

function transferAccount(id: string, accounts: readonly AssetAccount[]): TransferAccountSelection {
  return { id, snapshot: accounts.find((account) => account.id === id) };
}

function previousTransaction(state: HomeEditorState) {
  return isTransferEditor(state)
    ? { previousTransactionType: state.previousTransactionType, previousAccountId: state.previousAccountId }
    : { previousTransactionType: state.type, previousAccountId: state.accountId };
}

export function homeEditorReducer(state: HomeEditorState, action: HomeEditorAction): HomeEditorState {
  switch (action.type) {
    case 'switch-transaction':
      // Changing income/expense while editing still updates the original transaction.
      return state.kind === 'edit-transaction'
        ? { ...state, type: action.transactionType, categoryId: '' }
        : {
            kind: 'create-transaction', type: action.transactionType, categoryId: '',
            accountId: isTransferEditor(state) ? state.previousAccountId : state.accountId,
            quickReentryParents: null,
          };
    case 'switch-transfer':
      return isTransferEditor(state) ? state : {
        kind: 'create-transfer', ...previousTransaction(state),
        source: { id: '' }, destination: { id: '' },
      };
    case 'edit-transaction':
      return {
        kind: 'edit-transaction', record: action.record, type: action.record.type,
        categoryId: action.record.categoryId, accountId: action.record.accountId,
      };
    case 'edit-transfer':
      return {
        kind: 'edit-transfer', record: action.record, ...previousTransaction(state),
        source: transferAccount(action.record.sourceAccountId, action.accounts),
        destination: transferAccount(action.record.destinationAccountId, action.accounts),
      };
    case 'reset':
      return isTransferEditor(state)
        ? {
            kind: 'create-transfer', ...previousTransaction(state),
            source: transferAccount(state.source.id, action.accounts),
            destination: transferAccount(state.destination.id, action.accounts),
          }
        : {
            kind: 'create-transaction', type: state.type,
            categoryId: state.categoryId, accountId: state.accountId,
            quickReentryParents: null,
          };
    case 'restore-picks':
      return state.kind === 'create-transaction' && state.type === action.transactionType
        ? {
            ...state,
            categoryId: action.categoryId || state.categoryId,
            accountId: action.accountId || state.accountId,
          }
        : state;
    case 'select-category':
      if (isTransferEditor(state)) return state;
      return state.kind === 'create-transaction'
        ? {
            ...state, categoryId: action.categoryId,
            quickReentryParents: state.quickReentryParents?.account
              ? { account: state.quickReentryParents.account } : null,
          }
        : { ...state, categoryId: action.categoryId };
    case 'select-account':
      if (isTransferEditor(state)) return state;
      return state.kind === 'create-transaction'
        ? {
            ...state, accountId: action.accountId,
            quickReentryParents: state.quickReentryParents?.category
              ? { category: state.quickReentryParents.category } : null,
          }
        : { ...state, accountId: action.accountId };
    case 'quick-reentry':
      return state.kind === 'create-transaction'
        ? {
            ...state, categoryId: action.category.id, accountId: action.account.id,
            quickReentryParents: { category: action.category, account: action.account },
          }
        : state;
    case 'select-transfer-account':
      return isTransferEditor(state)
        ? { ...state, [action.side]: { id: action.account.id, snapshot: action.account } }
        : state;
    case 'swap-transfer-accounts':
      return isTransferEditor(state)
        ? { ...state, source: state.destination, destination: state.source }
        : state;
  }
}
