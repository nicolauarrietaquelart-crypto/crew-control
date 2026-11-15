CREATE TABLE crew_manager (
 id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, password_hash TEXT NOT NULL
);
CREATE TABLE crew_manager_sessions (
 token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, setup INTEGER NOT NULL
);
CREATE TABLE crew_manager_attempts (
 source TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
);
CREATE TABLE service_pdf_documents (
 service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
 document_key TEXT NOT NULL, filename TEXT NOT NULL, content BLOB NOT NULL,
 PRIMARY KEY(service_id, document_key)
);
