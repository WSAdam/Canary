import type { RelayPublicDto } from "./relay-dto.ts";

/** response for GET /relays — configured relays, token hashes omitted */
export interface RelayListDto {
  relays: RelayPublicDto[];
}
