export class BudgetUnavailableError extends Error {
  constructor(message = "Campaign budget reservation unavailable") {
    super(message);
    this.name = "BudgetUnavailableError";
  }
}
