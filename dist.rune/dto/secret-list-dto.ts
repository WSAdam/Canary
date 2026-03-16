import type { SecretDto } from "./secret-dto.ts";

/** all stored secret key names */
export interface SecretListDto {
  secrets: SecretDto[];
}
