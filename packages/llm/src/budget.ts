// Daily LLM budget enforcement (LLD §8.5). The worker sums today's
// tender_classifications token columns; this guard decides whether the next
// classification may proceed. Exceeding the cap stops classification and the
// caller raises an alert.

export interface BudgetCheck {
  allowed: boolean;
  usedTokens: number;
  dailyCapTokens: number;
}

export function checkDailyBudget(usedTokens: number, dailyCapTokens: number): BudgetCheck {
  return {
    allowed: usedTokens < dailyCapTokens,
    usedTokens,
    dailyCapTokens,
  };
}
