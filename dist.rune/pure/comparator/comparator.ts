import type { CheckDto } from "../../dto/check-dto.ts";
import { CanaryError } from "../../dto/_shared.ts";

export class Comparator {
  static evaluate(dto: CheckDto, observed: number): boolean {
    const { comparatorOp: op, threshold } = dto;
    switch (op) {
      case "lt": return observed < threshold;
      case "gt": return observed > threshold;
      case "lte": return observed <= threshold;
      case "gte": return observed >= threshold;
      case "eq": return observed === threshold;
      default:
        throw new CanaryError("extraction-failed", `Unknown comparatorOp: "${op}" — expected lt, gt, lte, gte, or eq`, 422);
    }
  }
}
