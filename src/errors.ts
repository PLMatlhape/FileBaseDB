export class FileBaseDBError extends Error {
  readonly code: string;

  constructor(message: string, code = "FILEBASEDB_ERROR") {
    super(message);
    this.name = "FileBaseDBError";
    this.code = code;
  }
}

export class AuthenticationError extends FileBaseDBError {
  constructor(message: string) {
    super(message, "AUTHENTICATION_ERROR");
    this.name = "AuthenticationError";
  }
}

export class ConfigurationError extends FileBaseDBError {
  constructor(message: string) {
    super(message, "CONFIGURATION_ERROR");
    this.name = "ConfigurationError";
  }
}

export class ProviderError extends FileBaseDBError {
  constructor(message: string) {
    super(message, "PROVIDER_ERROR");
    this.name = "ProviderError";
  }
}

export class MetadataError extends FileBaseDBError {
  constructor(message: string) {
    super(message, "METADATA_ERROR");
    this.name = "MetadataError";
  }
}

export class WriteConflictError extends FileBaseDBError {
  constructor(message: string) {
    super(message, "WRITE_CONFLICT_ERROR");
    this.name = "WriteConflictError";
  }
}
