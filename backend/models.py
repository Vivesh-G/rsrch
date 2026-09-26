from typing import Optional, List
from pydantic import BaseModel, Field
import time


class NoteBase(BaseModel):
    content: str = Field(default="", max_length=200_000)


class NoteResponse(NoteBase):
    document_id: str
    updated_at: float = Field(default_factory=time.time)


class DocumentBase(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    note_title: Optional[str] = Field(default=None, max_length=120)
    tag: str = Field(default="General", min_length=1, max_length=30)
    bookmarked: bool = False
    doc_type: str = Field(default="pdf", max_length=10)


class DocumentUpdate(BaseModel):
    note_title: Optional[str] = Field(default=None, max_length=120)
    tag: Optional[str] = Field(default=None, min_length=1, max_length=30)
    bookmarked: Optional[bool] = None
    doc_type: Optional[str] = Field(default=None, max_length=10)


class DocumentResponse(DocumentBase):
    id: str
    workspace_id: str
    added_at: float
    page_count: int = 1
    has_file: bool = False


class WorkspaceBase(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class WorkspaceUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
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
    title: Optional[str] = Field(default=None, max_length=120)
    document_id: Optional[str] = Field(default=None, max_length=128)


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
    api_key: Optional[str] = Field(default=None, max_length=200)
    model: Optional[str] = Field(default=None, max_length=60)


class ChatSendResponse(BaseModel):
    message: ChatMessage


class SettingsResponse(BaseModel):
    user_name: str = "Researcher"
    user_affiliation: str = ""
    gemini_model: str = "gemini-3.5-flash-lite"
    gemini_api_key_set: bool = False
    gemini_api_key_masked: str = ""
    ai_temperature: float = 0.7
    ai_persona: str = "academic"
    auto_compile_delay: int = 1500
    editor_font_size: int = 13
    editor_word_wrap: bool = True
    editor_line_numbers: bool = True


class SettingsUpdate(BaseModel):
    user_name: Optional[str] = Field(default=None, max_length=60)
    user_affiliation: Optional[str] = Field(default=None, max_length=100)
    gemini_model: Optional[str] = Field(default=None, max_length=60)
    gemini_api_key: Optional[str] = Field(default=None, max_length=200)
    ai_temperature: Optional[float] = Field(default=None, ge=0.0, le=2.0)
    ai_persona: Optional[str] = Field(default=None, max_length=50)
    auto_compile_delay: Optional[int] = Field(default=None, ge=0, le=10000)
    editor_font_size: Optional[int] = Field(default=None, ge=10, le=24)
    editor_word_wrap: Optional[bool] = None
    editor_line_numbers: Optional[bool] = None

