import type { CheckDto } from "../../dto/check-dto.ts";
import type { ResponseDto } from "../../dto/response-dto.ts";
import { BaseSource } from "./shared/mod.ts";
import { Http } from "./implementations/http/mod.ts";
import { Internal, isInternalUrl } from "./implementations/internal/mod.ts";

export class Source {
  private constructor(private readonly impl: BaseSource) {}

  static fromCheck(dto: CheckDto): Source {
    // An `internal:` url names a producer Canary runs in-process (see the
    // internal source) — everything else is an ordinary HTTP fetch.
    return new Source(isInternalUrl(dto.url) ? new Internal() : new Http());
  }

  async fetch(dto: CheckDto, secretValues?: string[]): Promise<ResponseDto> {
    return await this.impl.fetch(dto, secretValues);
  }
}
