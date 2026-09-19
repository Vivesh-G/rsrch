from typing import Optional, List
from pydantic import BaseModel, Field
import time


class NoteBase(BaseModel):
    content: str = ""


class NoteResponse(NoteBase):
    document_id: str
    updated_at: float = Field(default_factory=time.time)


class DocumentBase(BaseModel):
    name: str
    note_title: Optional[str] = None
    tag: str = "General"
    bookmarked: bool = False


class DocumentUpdate(BaseModel):
    note_title: Optional[str] = None
    tag: Optional[str] = None
    bookmarked: Optional[bool] = None


class DocumentResponse(DocumentBase):
    id: str
    workspace_id: str
    added_at: float
    page_count: int = 1
    has_file: bool = False


class WorkspaceBase(BaseModel):
    name: str


class WorkspaceUpdate(BaseModel):
    name: Optional[str] = None
    expanded: Optional[bool] = None


class WorkspaceResponse(WorkspaceBase):
    id: str
    expanded: bool = True
    created_at: float
    docs: List[DocumentResponse] = []


class SearchResultItem(BaseModel):
    document_id: str
    workspace_id: str
    workspace_name: str
    document_name: str
    note_title: str
    tag: str
    snippet: Optional[str] = None
    match_type: str  # "name", "title", "tag", "note"


class SearchResponse(BaseModel):
    query: str
    results: List[SearchResultItem]


class ChatMessage(BaseModel):
    id: Optional[int] = None
    chat_id: Optional[str] = None
    document_id: Optional[str] = None
    role: str
    content: str
    created_at: float


class ChatCreate(BaseModel):
    title: Optional[str] = None
    document_id: Optional[str] = None


class ChatSessionResponse(BaseModel):
    id: str
    title: str
    document_id: Optional[str] = None
    origin_title: Optional[str] = None
    message_count: int = 0
    last_preview: Optional[str] = None
    created_at: float
    updated_at: float


class ChatSendRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    document_ids: List[str] = Field(default_factory=list, max_length=3)


class ChatSendResponse(BaseModel):
    message: ChatMessage
