CREATE TABLE service_pdf_chunks (
 service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
 document_key TEXT NOT NULL,
 position INTEGER NOT NULL,
 filename TEXT NOT NULL,
 content BLOB NOT NULL,
 PRIMARY KEY(service_id, document_key, position)
);
