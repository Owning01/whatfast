# WhatsApp Desktop 2.2640.100.0 — Feature Baseline

Comparison baseline for the WhatsApp clone in this repo.
Built from static analysis artifacts of the real app (no runtime capture, no network calls).

## Provenance

| Artifact | Size | What it holds |
| --- | --- | --- |
| `views.txt` | 97 XAML view names | Native shell views (VoIP, debug, native pickers) |
| `abprops_list.txt` | 1210 A/B feature flags | `AbPropertyCode.*` runtime experiment switches |
| `features.txt` | 2384 lines | Feature-keyword hits over all assemblies (types + method names) |
| `named_types.txt` | 8539 types | Every named type, prefixed with its assembly |
| `viewmodels.txt` | 15 view models | Native view models |
| `services.txt` | 103 services | Native services/handlers |

All paths below are relative to `C:\Users\tu_usuario\AppData\Local\Temp\whatsapp_analysis\`.

**Evidence notation**

- `views.txt` → `ViewName` (HIGH: a real XAML view class exists)
- `abprops_list.txt` → `AbPropertyCode.flag_name` (HIGH: a real runtime flag exists)
- `named_types.txt` → `[Assembly] TypeName` (HIGH when it is a concrete protocol/data type; MEDIUM when it is only a telemetry enum name)
- `features.txt` → `TypeName` (same assembly, no prefix)

**Confidence**

- **HIGH** — seen in `views.txt`, an explicit `AbPropertyCode` flag, or a concrete protocol/data type (`WhatsApp.ProtoBuf.*`, `WhatsApp.Data.*`, `WhatsApp.Wam.Enum.*` value lists).
- **MEDIUM** — only a type name exists (usually a telemetry/logging enum), and the feature is inferred from the name.

---

## 0. Architecture finding that shapes the whole baseline

**The chat screen of WhatsApp Desktop 2.2640.100.0 is not native XAML. It is a WebView2 web app.**

Evidence:

- `named_types.txt` → `[WhatsApp.Root] WhatsApp.Bridge.WebLifecycleController`, `[WhatsApp.Root] WhatsApp.Bridge.WebContentUpdateManager`, `[WhatsApp.Root] WhatsApp.AdvancedWebView2NavigationStatusMonitor`
- `named_types.txt` → `[WhatsApp.Root] WhatsApp.Bridge.LinkPreviewProvider`, `[WhatsApp.Root] WhatsApp.Bridge.PicturesManager`, `[WhatsApp.Root] WhatsApp.Bridge.MediaTranscodingService`
- `named_types.txt` → `[WhatsApp.Root] ABI.WinRTAdapter.ILinksPreviewBridge`, `ABI.WinRTAdapter.IPicturesBridge`, `ABI.WinRTAdapter.IMediaTranscodingBridge`, `ABI.WinRTAdapter.ISharesheetBridge`
- `named_types.txt` → `[WhatsApp.Root] WhatsApp.WebView2NavigationStatusMonitor`, `[WhatsApp.Root] WhatsApp.WebView2ContextMenuHelper`
- `abprops_list.txt` → `webview2_disable_gpu_acceleration`, `webview2_enable_offline_support`, `win_hybrid_use_minimal_window`, `wa_web_adaptive_layout_enabled`
- `views.txt` contains **zero** chat views. All 97 views are VoIP, native dialogs, debug pages, and the emoji picker.

Consequence for a clone: the real app's chat feature surface is mostly **telemetry enums** (`WhatsApp.Wam.Enum.*`, `WhatsApp.Wam.Event.*`) plus **wire protocol types** (`WhatsApp.ProtoBuf.*`). Those two sources are the best available proxy for "what the real chat screen can do", and they are what this baseline is built from.

**Native (XAML) surfaces that do touch chat:** the emoji picker, the disappearing-timer label, the notification controls, the group safety-check exit dialog, the contacts-permission dialogs.

---

# Section A — Chat screen

## A1. Message bubble variants

`named_types.txt` → `[WhatsApp.DataModels] WhatsApp.MessageType` — full value list:

| Value | Meaning |
| --- | --- |
| `Text` (via `ExtendedText=9`) | Plain text |
| `Image=1` | Image |
| `Audio=2` | Audio file |
| `Video=3` | Video |
| `Contact=4` | Shared contact card |
| `Location=5` | Static location |
| `LiveLocation=11` | Live location |
| `Document=8` | Document |
| `Gif=10` | Animated GIF |
| `Sticker=19` | Sticker |
| `Reaction=29` | Reaction message |
| `GroupInvite=12` | Group invite |
| `ViewOnceImage=1016` | View-once image |
| `ViewOnceVideo=1017` | View-once video |
| `ViewOnceAudio=1039` | View-once audio |
| `ViewOnceText=1040` | View-once text |
| `PollCreation=1020` | Poll |
| `PollUpdate=1021` | Poll vote |
| `KeepInChat=1024` | Keep-in-chat |
| `MessageEdit=1027` | Edited message |
| `AdminRevoked=1025` | Admin-revoked |
| `OutgoingAdminRevoke=1026` | Outgoing admin revoke |
| `PinInChat=1042` | Pin-in-chat |
| `AlbumMessage=1047` | Album (multi-image) |
| `Comment=1037` | Comment |
| `EventCreation=1043` / `EventResponse=1045` | Events (v2) |
| `SecretEncryptedMessage=1044` | Secret (E2EE) message |
| `TypingIndicator=1046` | Typing indicator |
| `BotWelcomeMessage=1028` / `BotFeedbackMessage=1029` | AI-bot messages |
| `InChatCallingMessageVoice=1035` / `InChatCallingMessageVideo=1036` | In-chat call card |
| `ScheduledCallCreateMessageVoice=1032` / `Video=1033` / `ScheduledCallEditMessage=1034` | Scheduled call |
| `Revoked=1006` | Revoked |
| `MultiDevicePlaceholder=1008` | MD placeholder |
| `PlaceholderMessage` / `FixedContentPlaceholder=1041` | Unsupported placeholder |
| `PeerDataOperationRequestMessage=1022` | Unknown-contact ("peer data op") chat |
| `CipherText=1000` / `ProtocolBuffer=1001` / `Unsupported=1002` | Undecryptable / unsupported |
| `HistorySyncNotification=1010`, `SyncDPatch=1011`, `AppStateSyncKey*` | Sync / app-state |
| `EphemeralSetting=1018` | Disappearing-timer system message |
| `Divider=6`, `System=7` | Date divider / system message |

`named_types.txt` → `[WhatsApp.DataModels] WhatsApp.PlaceholderTypes` — `NotAPlaceholder=0, CipherTextPlaceholder=1, MultiDevicePlaceholder=2, HostedSenderPlaceholder=3`

`named_types.txt` → `[WhatsApp.DataModels] WhatsApp.MediaPlaybackState` — `Stopped=0, Playing=1, Paused=2, Opening=3, None=4`

**Bubble render variants** — `named_types.txt` → `[WhatsApp.Core] RenderBubbleType` (HIGH, 79 values). The visual bubble taxonomy the real app uses:

`Text, Image, Audio, Video, Contact, Location, System, Document, MissedCall, DecryptionFailure, AnimatedGif, ContactArray, SenderRevoked, LiveLocation, HsmRejected, Sticker, PaymentRequestDeclined, PaymentRequestCancelled, Product, GroupInvite, TemplateImage, TemplateDocument, TemplateHsm, TemplateVideo, TemplateGif, TemplateLocation, MultiDevicePlaceholder, QuickReplyForTemplate, EphemeralSettingChange, Catalog, ViewOnceImage, ViewOnceVideo, Order, MultiElement, MultiElementResponse, ButtonsResponse, PaymentInvite, ProductList, Checkout, InteractiveMessage, InteractiveImageMessage, InteractiveVideoMessage, InteractiveDocumentMessage, Poll, RequestPhoneNumber, SharePhoneNumber, ViewOnceText, ScheduledCall, PushToVideo, ViewOnceAudio, ScheduledCallEditLegacy, InteractiveLocationMessage, CallLog, Bcall, Event, EventResponse, NewsletterAdminInvite, FixedContentPlaceholder, MessageDropPlaceholderInternal, InteractiveProductMessage, Album, WebPage, InterativeResponse, NewsletterEvent, NewsletterAdminActivation, Unsupported, BotWelcome, BotFeedback, BotMenuOnboarding, StatusMention, StickerPack, PollResultSnapshot, Future, AIRichResponse, InteractiveGifMessage, ConversationRowSingleEmoji, LimitSharingSettingChange, EventInvite`

**Wire protocol message variants** — `named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.Message` (nested types, HIGH). 115 concrete message classes including:
`AlbumMessage, AudioMessage, BCallMessage, ButtonsMessage, ButtonsResponseMessage, CallLogMessage, CommentMessage, ConditionalRevealMessage, ContactMessage, ContactsArrayMessage, ConversationMessage, DocumentMessage, EncCommentMessage, EncEventResponseMessage, EncReactionMessage, EventInviteMessage, EventMessage, EventResponseMessage, ExtendedTextMessage, FutureProofMessage, GroupInviteMessage, HighlyStructuredMessage, ImageMessage, InteractiveMessage, InteractiveResponseMessage, InvoiceMessage, KeepInChatMessage, ListMessage, ListResponseMessage, LiveLocationMessage, LocationMessage, NewsletterAdminInviteMessage, NewsletterFollowerInviteMessage, OrderMessage, PaymentInviteMessage, PaymentLinkMetadata, PaymentReminderMessage, PinInChatMessage, PlaceholderMessage, PollAddOptionMessage, PollCreationMessage, PollResultSnapshotMessage, PollUpdateMessage, PollVoteMessage, ProductMessage, QuestionResponseMessage, ReactionMessage, RequestPaymentMessage, RequestPhoneNumberMessage, ScheduledCallCreationMessage, ScheduledCallEditMessage, SendPaymentMessage, SplitPaymentMessage, StatusNotificationMessage, StatusQuestionAnswerMessage, StatusQuotedMessage, StatusStickerInteractionMessage, StickerMessage, StickerPackMessage, TemplateMessage, TemplateButtonReplyMessage, VideoMessage`

**Message delivery state** — `named_types.txt` → `[WhatsApp.Core] WhatsApp.MessageDeliveryStatus` (HIGH):
`NotSet, Uploading, Uploaded, ReceivedByServer, ReceivedByTarget, NeverSend, Undefined, Unsent, Error, PlayedByTarget, Canceled, UploadingCustomHash, Downloading, ReadByTarget, Pending, ReceivedByInactiveTarget, ErrorSentToNonMdUser`

**Message send outcomes** — `named_types.txt` → `[WhatsApp.Core] MessageSendResultType` (HIGH):
`Ok, ErrorUnknown, ErrorNetwork, ErrorExpired, ErrorCancelled, ErrorUpload, ErrorBackfillUnusyncFailed, ErrorPayloadTooBig, ErrorLocation, ErrorInvalidMessage, ErrorE2ee, ErrorInvalidProtobuf, ServerError, EphemerallyExpired, MediaUploadFailed, ErrorClientOutOfMemory, ErrorUploadCancelledManually, ErrorUploadCancelledAutomatic, ErrorBoundedStanzaTooLarge, AeaSendReconcilationFailure`

**Protocol message type enum** — `named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.MessageTypes` (HIGH, 44 values):
`none, conversation, sender_key_distribution_message, image_message, contact_message, location_message, extended_text_message, document_message, audio_message, video_message, call, protocol_message, contacts_array_message, highly_structured_message, template_message, send_payments_message, request_payment_message, live_location_message, sticker_message, template_button_reply_message, device_sent_message, device_sync_message, future_proof_message, chat, decline_payment_request_message, cancel_payment_request_message, group_invite_message, product_message, reaction_message, poll_creation, poll_update, keep_in_chat, message_edit, pin_in_chat, ptv_message, scheduled_call_creation_message, scheduled_call_edit_message, call_log_message, placeholder_message, event_creation, event_response, secret_encrypted_message, album_message`

**Semantic media-type taxonomy** — `named_types.txt` → `[WhatsApp.Core] MediaType` (HIGH, 80 values). This is the closest thing to "what a bubble can contain":
`None, Photo, Video, Audio, Ptt, Location, Contact, Document, Url, Call, Gif, Future, ContactArray, LiveLocation, ProfilePic, Sticker, Hsm, ProductImage, Template, MDAppState, MDHistorySync, CatalogLink, ProductLink, Order, List, ListReply, ButtonMessage, ButtonResponseMessage, ProductList, ButtonNfm, ViewOnceImage, ViewOnceVideo, ShopStorefront, Reaction, InteractiveNfm, InteractiveResponseNfm, PollCreate, PollVote, Text, Keep, Unkeep, InvisibleHello, MediaExpressNotify, UndecryptedMedia, UndecryptedText, UndecryptedPay, UndecryptedPoll, UndecryptedReaction, UndecryptedMediaNotify, ViewOnceAudio, ScheduledCallCreate, ScheduledCallCancel, PushToVideo, PinInChat, InteractiveCarousel, Comment, EphemeralSyncResponse, EventCreate, EventRespond, LottieSticker, InteractiveProductCarousel, InteractiveProduct, MediaAlbum, StickerPack, PollResultSnapshot, MusicArtwork, RichResponse, MotionPhoto, MotionVideo, Appdata, GroupHistory, GroupHistoryNotice, MemberTag, DocCollection, VideoCollection, MixedCollection, ConditionalReveal, EventInvite, StickerReaction, Music`

**Album / multi-image** — `named_types.txt` → `[WhatsApp.Core] MessageTypeCategory` (HIGH): `SingleImage=1, ImageAlbum=2, Text=3, Audio=4, Video=5`

**Text formatting inside bubbles** — `named_types.txt` → `[WhatsApp.Core] WhatsApp.RichTextFormat` (HIGH), a bitmask:
`None=0, Link=1, Emoji=2, Bold=4, Italic=8, Code=16, Strikethrough=32, TextFormattings=60, Emoticon=64, Foreground=128, Mention=256, NewLines=512, Email=1024, PhoneNumber=2048, InternalLinks=4096, InlineCode=8192, ListItems=16384, GroupMention=32768, DefaultFormatting=44351`

`named_types.txt` → `[WhatsApp.RichTextFormatting] WhatsApp.RichTextFormatting.Processors.*` (HIGH) — one processor per inline format: `CodeBlocksProcessor, EmailsProcessor, EmojiProcessor, InlineCodeProcessor, LinksProcessor, ListItemProcessor, MentionsProcessor, NewLineProcessor, PhoneNumbersProcessor, TextFormattingProcessor`

`named_types.txt` → `[WhatsApp.DataModels] WhatsApp.Formatting.MentionState` (HIGH) — fields `Jid, Length, Start, Text, IsEditingMessage, End`

`named_types.txt` → `[WhatsApp.Core] MentionType` (HIGH): `RegularUser=0, Group=1, MetaAIBot=2, Everyone=3, NonGroupUser=4`

---

## A2. Composer

`named_types.txt` → `[WhatsApp.Core] ChatComposerActionTargets` (HIGH): `Attachment=1, Camera=2, Ptt=3, Payment=4, Gimmick=5, Phone=6, Video=7, Message=8, Call=9`

`named_types.txt` → `[WhatsApp.Core] ChatComposerActionTypes` (HIGH): `Click=1`

`named_types.txt` → `[WhatsApp.Core] TextMessageUserJourneyAction` (HIGH):
`TypingStart=1, Cleared=2, Sent=3, DraftSaved=4, Exit=5, ClickOnComposer=6, Delivered=7, DraftLoaded=8`

`named_types.txt` → `[WhatsApp.Core] QuickActionBarAction` (HIGH): `Click=1, Impression=2, Open=3, Close=4`
`named_types.txt` → `[WhatsApp.Core] QuickActionPillType` (HIGH): `Catalog=1, QuickReply=2, Order=3, ToggleButton=4`

`named_types.txt` → `[WhatsApp.Core] ConversationStarterAction` / `ConversationStarterMediaType` (HIGH): `Emoji=1, Sticker=2`

**Native emoji picker (XAML, in the shell — used by the composer and the reaction tray)** — `views.txt` (HIGH):
`EmojiPickerControl`, `EmojiGridView`, `EmojiCategoryGridView`, `EmojiItemView`, `VariantEmojiItemView`, `EmojiVariantListView`, `SkinToneEmojiPickerControl`
plus `named_types.txt` → `[WhatsApp.Design] WhatsApp.EmojiPickerControl`, `[WhatsApp.Design] WhatsApp.EmojiGridView`, `[WhatsApp.Design] WhatsApp.EmojiCategoryGridView`, `[WhatsApp.Design] WhatsApp.EmojiItemView`, `[WhatsApp.Design] WhatsApp.EmojiVariantListView`, `[WhatsApp.Design] WhatsApp.Controls.SkinToneEmojiPickerControl`, `[WhatsApp.Design] WhatsApp.Controls.EmojiVariantListView`
plus `named_types.txt` → `[WhatsApp.Root] WhatsApp.ViewModels.Emoji.EmojiPickerVm`, `EmojiPickerCategoryVm`, `EmojiSearchVm`, `EmojiItemVm`, `EmojiItemVariantVm`, `EmojiPickerVmFactory`, `EmojiSkinTonePreferences`

`named_types.txt` → `[WhatsApp.RichTextFormatting] WhatsApp.EmojiCatalog`, `WhatsApp.EmojiShortcuts`, `WhatsApp.EmojiSkinModifier`, `WhatsApp.TextUtils.MultiSkinToneEmojiTools` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] RecentEmojiWeightsAction`, `[WhatsApp.Protobuf] WhatsApp.GProtoBuf.RecentEmojiWeight` (HIGH) — recently-used emoji weights are synced.

**Slash commands** — `named_types.txt` → `[WhatsApp.Core] ChatFilterActionTypes` (HIGH) contains `SlashIconButtonClick`, `SlashCommandClick`, `SlashIconTyped`, `SlashCommandPromptSubmit`.

**Typing indicator (outgoing)** — `named_types.txt` → `[WhatsApp.Networking] WhatsApp.Smax.Generated.Chatstate.Outgoing.ComposingMixin`, `ComposingMixinComposing` (HIGH)

---

## A3. Message context menu (long-press / overflow on a message)

`named_types.txt` → `[WhatsApp.Core] MessageContextMenuOptionType` (HIGH) — **40 options**, the single most complete list of the real message menu:

`Unknown=1, Overflow=2, Forward=3, Delete=4, Reply=5, ReplyPrivately=6, StarOrUnstar=7, Copy=8, Report=9, MessageContact=10, MessageInfo=11, Edit=12, ForwardSelectMessages=13, DeleteSelectMessages=14, Select=15, AddToCalendar=16, CopyLinkUrl=17, React=18, Download=19, KeepOrUnkeep=20, FavoriteOrUnfavoriteSticker=21, CopySticker=22, ViewStickerPack=23, DownloadAll=24, SaveAs=25, Share=26, PinOrUnpin=27, AskMetaAI=28, BotFeedback=29, ReportToAdmin=30, CopyNewsletterLink=31, PaidPartnership=32, VerifySecurityCode=33, AddToNote=34, Translate=35, Speak=36, ViewTranslation=37, RemoveTranslation=38, SelectText=39, CopySelection=40`

`named_types.txt` → `[WhatsApp.Core] MessageContextMenuActionType` (HIGH): `Open=1, Click=2, Complete=3, Cancel=4`

**Swipe gestures on a bubble** — `named_types.txt` → `[WhatsApp.Core] ChatFilterActionTypes` (HIGH) contains `SwipeToReply=171`.

**Message-level analytics** — `named_types.txt` → `[WhatsApp.Core] MessageLevelAction` (HIGH):
`Star=0, Forward=1, Copy=2, Report=3, Delete=4, ButtonClick=5, LinkClick=6, MessageView=7, Unstar=8, Share=9, AddContact=10, Rate=11, PinMessage=12, UnpinMessage=13, DownloadHdMedia=14, UrlFrictionBannerView=15`

**Chat-header overflow menu (the "three-dot" menu)** — `named_types.txt` → `[WhatsApp.Core] MoreMenuActionType` (HIGH), 33 entries:
`Unknown=0, GroupInfo=1, GroupMedia=2, Search=3, MuteNotifications=4, DissappearingMessages=5, ChatThemes=6, AddMembers=7, Report=8, ExitGroup=9, ClearChat=10, ExportChat=11, AddShortcut=12, AddToList=13, NewGroup=14, MediaLinksDocs=15, ViewContact=16, ClickThreeDot=17, Dismiss=18, Block=19, Unblock=20, More=21, SendCallLink=22, ScheduleCall=23, NewGroupCall=24, Close=25, LabelChat=26, CreateOrder=27, AISettings=28, AssignChat=29, ViewShops=30, ViewCatalog=31, CallingOptions=32`

`named_types.txt` → `[WhatsApp.Core] MoreMenuSurface` (HIGH): `Unknown=0, ChatHeader=1, ThreeDotMenu=2, ThreeDotSubMenu=3, CallingOptionsSubMenu=4`

---

## A4. Link previews

`named_types.txt` → `[WhatsApp.Core] UrlPreviewState` (HIGH): `None=1, Text=2, SmallThumbnail=3, LargeThumbnail=4, LargeVideoThumbnail=5`

`named_types.txt` → `[WhatsApp.Core] UrlStatusType` (HIGH):
`NoPreview=1, Truncated=2, NonTruncated=3, Interactable=4, TopBarAttribution=5, InlineVideoCta=6, PsaCta=7`

`named_types.txt` → `[WhatsApp.Core] TopBarAttributionType` (HIGH), 21 entries:
`Music=0, Crossposting=1, Mention=2, ResharedStatus=3, ResharedFromMention=4, Channel=5, Fb=6, Ig=7, Spotify=8, E2ee=9, Rl=10, GroupStatus=11, SharingApi=12, ForwardStatus=13, AICreated=14, Layouts=15, CloseSharing=16, ChannelStatus=17, ResharedFromChannel=18, UsernameStatus=19, AIContent=20`

`named_types.txt` → `[WhatsApp.Core] LinkMetadataFetch`, `LinkMetadataFetchImageUrlType`, `LinkSource`, `LinkFrictionFunnel`, `LinkFrictionUIAction` (HIGH)

`named_types.txt` → `[WhatsApp.Core] PrivacySettingDisableLinkPreviewsAction`, `PrivacySettingDisableLinkPreviewsDaily` (HIGH) — link previews are a per-chat privacy toggle.

`named_types.txt` → `[WhatsApp.Root] WhatsApp.Bridge.LinkPreviewProvider`, `[WhatsApp.Root] WhatsApp.Tools.LinkPreviewUtils`, `WhatsApp.Tools.WebPageMetadata`, `WhatsApp.Tools.IWebPageMetadata` (HIGH) — native link-preview fetcher behind `ABI.WinRTAdapter.ILinksPreviewBridge`.

`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.LinkPreviewMetadata`, `URLMetadata`, `WhatsApp.ProtoBuf.WebLinkRenderConfig` (HIGH)

`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.GProtoBuf.LinkPreviewHighQualityThumbnail`, `WhatsApp.GProtoBuf.WebLinkRenderConfig` (HIGH)

`named_types.txt` → `[WhatsApp.Core] SuspiciousLinkBanner`, `SuspiciousLinkBannerAction`, `SuspiciousLinkClassified`, `SuspiciousLinkPromptReason`, `SuspiciousLinkSenderRelationship`, `SuspiciousLinkThreadType`, `SuspiciousCharLinkDialogInteraction` (HIGH) — link safety/interstitial system.

---

## A5. Media viewer (full-screen)

`named_types.txt` → `[WhatsApp.Core] MediaViewerActionType` (HIGH) — **30 actions**:
`Play=1, Pause=2, Forward=3, ViewInGallery=4, Edit=5, Favorite=6, Share=7, SeeAllMedia=8, CreateSticker=9, GoToMessage=10, Save=11, Rotate=12, Delete=13, Copy=14, ReportUser=15, SetAsProfilePhoto=16, SetAsGroupIcon=17, SetAsWallpaper=18, Reply=19, Expand=20, SetReactionEmoji=21, ViewReactions=22, SetPlaybackSpeed=23, OpenPip=24, ClosePip=25, SelectSpecificTimeInVideo=26, SelectMediaInMediaStrip=27, SwipeLeftRight=28, CloseMediaPlayer=29, TapAskMetaAI=30`

`named_types.txt` → `[WhatsApp.Core] MediaViewerEntryPoint` (HIGH): `IndividualChat=0, GroupChat=1, MediaLinksDocsPage=2, Search=3, StarredMessages=4, Channel=5, Storage=6`

`named_types.txt` → `[WhatsApp.Core] MediaViewerActions`, `MediaViewerItemImpression` (HIGH)

`named_types.txt` → `[WhatsApp.Core] ViewerSheetAction` (HIGH), 27 entries:
`ViewerSheetImpression=1, MessageClick=2, ProfileRingClick=3, ContactInfoClick=4, ContactInfoMessageClick=5, ContactInfoAudioClick=6, ContactInfoVideoClick=7, ContactInfoProfileRingClick=8, ForwardClick=9, ShareClick=10, ShareToFacebookClick=11, ShareToInstagramClick=12, DeleteClick=13, HideClick=14, AudiencePillClick=15, AudienceDistributionModeClick=16, AudienceMentionsClick=17, ViewerSheetOpenFromNotification=18, QuestionAnswerReplyClick=19, QuestionAddToStatusClick=20, QuestionAnswerReplyTextTyped=21, QuestionAnswerSeeAllClick=22, ReactionStickerReplyClick=23, ReactionStickerSeeAllClick=24, RepliesOpenChatClick=25, RepliesQuoteMsgClick=26, RepliesSeeAllClick=27`

`named_types.txt` → `[WhatsApp.Core] ViewerSheetSurface` (HIGH): `MainViewerSheet=1, QuestionAnswerSeeAll=2, ReactionStickerSeeAll=3, RepliesSeeAll=4`

`named_types.txt` → `[WhatsApp.Core] InlineVideoType`, `InlineVideoCtaClick`, `InlineVideoPlaybackClosed` (HIGH) — inline video player inside a bubble.

`named_types.txt` → `[WhatsApp.Core] VideoPlayOrigin` (HIGH): `Conversation=1, GalleryPicker=2, StarredMessages=3, MediaViewPager=4, OtherOrigin=5, Channels=6, Status=7`
`named_types.txt` → `[WhatsApp.Core] VideoPlaySurface` (HIGH): `ExternalVideoPlayerApp=1, InAppPagerView=2, InAppStandaloneView=3, WatchAndBrowse=4`
`named_types.txt` → `[WhatsApp.Core] VideoPlayType` (HIGH): `File=1, Stream=2, Sent=3`
`named_types.txt` → `[WhatsApp.Core] VideoEventType` (HIGH): `RequestedPlaying=1, Paused=2, Unpaused=3, CaptionChange=4, FinishedPlaying=5`
`named_types.txt` → `[WhatsApp.Core] PlaybackStateType`, `PlaybackOriginType` (HIGH)

`abprops_list.txt` → `enable_lanczos_video_inline_chat`, `enable_lanczos_video_chat_fullscreen`, `enable_rx_video_enhance_chat_fullscreen` (HIGH) — HD/enhanced video rendering in chat.

---

## A6. Media gallery / media hub / "Media, links & docs"

`named_types.txt` → `[WhatsApp.Core] ChatFilterTypes` (HIGH) — the chat-list filter pills, which in the real app double as the media gallery categories:
`None=0, OtherLabels=1, Unread=2, Group=3, BroadcastList=4, NewCustomer=5, NewOrder=6, PendingPayment=7, Paid=8, OrderComplete=9, Contact=10, NonContact=11, Photos=12, Gifs=13, Links=14, Videos=15, Documents=16, Audios=17, AssignedToYou=18, Personal=19, Business=20, Label=21, Favorites=22, Stickers=23, Community=24, BusinessAI=25, Drafts=26, CampaignReplies=27, BusinessFolder=28`

`named_types.txt` → `[WhatsApp.Core] MoreMenuActionType.MediaLinksDocs=14` (HIGH) — the "Media, links and docs" tab.
`named_types.txt` → `[WhatsApp.Core] MediaHubUserJourney` (HIGH)
`abprops_list.txt` → `enable_tooltip_for_media_hub` (HIGH)

`named_types.txt` → `[WhatsApp.Core] StarMessage`, `ViewStarredMessages`, `ViewStarredMessagesEntryPoint`, `StarMessageEntryPoint` (HIGH) — starred-messages browser.
`named_types.txt` → `[WhatsApp.Core] ForwardPicker`, `ForwardPickerOrigin` (HIGH): `StatusViewer=1, PttWidget=2`
`named_types.txt` → `[WhatsApp.Core] ForwardSource` (HIGH): `ContextMenu=1, ButtonRail=2, ImageForward=3`
`named_types.txt` → `[WhatsApp.Core] ForwardOrigin` (HIGH): `Unknown=1, Chat=2, Status=3, Channels=4, MetaAI=5`

---

## A7. Shared contact cards

`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.ContactMessage`, `ContactsArrayMessage` (HIGH)
`named_types.txt` → `[WhatsApp.Core] MediaType.Contact=7`, `ContactArray=13` (HIGH)
`named_types.txt` → `[WhatsApp.Core] RenderBubbleType.Contact=5`, `ContactArray=12` (HIGH)
`named_types.txt` → `[WhatsApp.Core] ChatOpenSource.ContactCard=8` (HIGH)
`named_types.txt` → `[WhatsApp.Core] MessageContextMenuOptionType.MessageContact=10` (HIGH)
`named_types.txt` → `[WhatsApp.Core] ContactSend`, `ContactSendChannel` (HIGH)

---

## A8. Location and live location

`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.LocationMessage`, `LiveLocationMessage`; `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.Location` — fields `DegreesLatitude, DegreesLongitude, Name` (HIGH)

`named_types.txt` → `[WhatsApp.Core] LiveLocationDurationPicker`, `LiveLocationDurationPickerEntryPoint` (HIGH): `Chat=1, LiveLocationMap=2, ReciprocalShare=3`
`named_types.txt` → `[WhatsApp.Core] LiveLocationReportingSession`, `LiveLocationReportingSessionSegment`, `LiveLocationReportingAlgorithm`, `LiveLocationBackoffStage` (HIGH)
`named_types.txt` → `[WhatsApp.Core] LiveLocationMessageStatus`, `LiveLocationMessageStatusResult`, `LiveLocationUpdateSent`, `LiveLocationSharingSession`, `LiveLocationSharingSessionEndedReason` (HIGH)
`named_types.txt` → `[WhatsApp.Core] LocationPicker`, `LocationPickerPlacesResponse`, `LocationPickerResultType`, `LocationScreenSource`, `LocationActionType`, `StaticLocationPoiActions` (HIGH)
`named_types.txt` → `[WhatsApp.Core] DefaultAudienceLocationType` (HIGH)

---

## A9. Polls

`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.PollCreationMessage`, `PollUpdateMessage`, `PollVoteMessage`, `PollAddOptionMessage`, `PollResultSnapshotMessage`, `PollProperties`, `PollEncValue` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.PollType` (HIGH): `POLL=0, QUIZ=1`
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.PollAdditionalMetadata` — field `PollInvalidated` (HIGH)
`named_types.txt` → `[WhatsApp.Core] PollActionType` (HIGH):
`OpenCreateModal=1, CreatePoll=2, ViewResultsModal=4, RemoveVote=5, Vote=6, ChangeVote=7, EditPollInitiated=8, EditPollCompleted=9`
`named_types.txt` → `[WhatsApp.Core] PollsActions`, `PollsDailyStats` (HIGH)

**Poll feature flags** (`abprops_list.txt`, HIGH):
`poll_add_option_creator_enabled`, `poll_add_option_enabled`, `poll_add_option_participant_enabled`, `poll_add_option_receiving_enabled`, `poll_creator_edit_enabled`, `poll_creator_edit_receiving_version`, `poll_end_time_enabled`, `poll_end_time_receiving_enabled`, `poll_hide_voters_enabled`, `poll_hide_voters_receiving_enabled`

`abprops_list.txt` → `enable_poll_results_contact_info_entry_point`, `enable_poll_settings_label_improved_layout` (HIGH)

---

## A10. Voice notes (PTT)

`named_types.txt` → `[WhatsApp.Core] PttMessageUserJourneyAction` (HIGH):
`Start=1, Pause=2, Resume=3, Fail=4, Send=5, Delete=6, AutoCancel=7, Lock=8, DraftSaved=9, DraftLoaded=10, WidgetTap=11, PttWidgetForwardPickerShown=12, PttWidgetRecipientSelected=13, PreviewPlayback=14`

`named_types.txt` → `[WhatsApp.Core] PttPlayback`, `PttDaily`, `PttLockC`, `PTTProps` (HIGH)
`named_types.txt` → `[WhatsApp.Core] PttPlayerType` (HIGH): `AudioQueue, Avplayer, Avaudioplayer, Opusplayer, Androidplayer, Exoplayer, Uwpplayer, Voipplayer`
`named_types.txt` → `[WhatsApp.Core] PttPlaybackSpeedType` (HIGH): `Speed1=0, Speed15=1, Speed2=2`
`named_types.txt` → `[WhatsApp.Core] PttWaveformResult` (HIGH): `Success=1, AllZeroes=2, AllOnes=3, Missing=4`
`named_types.txt` → `[WhatsApp.Core] PttWidgetActionTypes` (HIGH): `WidgetEnabled=1, WidgetDisabled=2, UpsellCtaTapped=3`
`named_types.txt` → `[WhatsApp.Core] PttWidgetAddSource`, `PttSourceType`, `PttTriggerType`, `PttStreamType`, `PttResultType`, `PttMessageUserJourneyStage`, `PttMessageUserJourneyFailureReason` (HIGH)

**Microphone state (native)** — `views.txt` → `MicrophoneSwitchedBannerView` (HIGH); `named_types.txt` → `[WhatsApp.Design] WhatsApp.Design.Voip.MicrophoneSwitchedBannerView` (HIGH)

**PTT widget in the chat list** — `named_types.txt` → `[WhatsApp.Core] PttWidgetEvent` (HIGH)

---

## A11. Documents

`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.DocumentMessage` (HIGH)
`named_types.txt` → `[WhatsApp.Core] DocumentType` (HIGH): `Other=1, Image=2, Video=3, Audio=4, Document=5, CompressedFile=6, Executable=7, Vcard=8`
`named_types.txt` → `[WhatsApp.Core] DocumentDetection`, `SendDocument` (HIGH)
`named_types.txt` → `[WhatsApp.Core] MediaType.Document=8`, `DocCollection=74` (HIGH)
`named_types.txt` → `[WhatsApp.Core] DocScanEntrypoint`, `DocScanResult` (HIGH) — document malware scanning.
`abprops_list.txt` → `wa_win_pdf_rendering_enabled` (HIGH) — inline PDF rendering on Windows.

---

## A12. Video and GIF

`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.VideoMessage`, `ImageMessage`, `AudioMessage` (HIGH)
`named_types.txt` → `[WhatsApp.Core] MediaType.Gif=11`, `MotionPhoto=68`, `MotionVideo=69`, `VideoCollection=75` (HIGH)
`named_types.txt` → `[WhatsApp.Core] GifSearchSessionStarted`, `GifSearchCancelled`, `GifSearchNoResults`, `GifSearchProvider`, `GifSearchResultTapped` (HIGH) — built-in GIF search.
`named_types.txt` → `[WhatsApp.Core] VideoTranscoder`, `VideoTranscoderAlgorithmType`, `VideoTranscoderResultType`, `VideoTranscoderSourceFormatType`, `VideoTranscoderTargetFormatType` (HIGH)
`named_types.txt` → `[WhatsApp.Root] WhatsApp.MediaTranscoder`, `[WhatsApp.Root] WhatsApp.NativeTranscodeWrapper`, `[WhatsApp.Root] WhatsApp.SystemIntegrations.MediaTranscodingService` (HIGH)
`abprops_list.txt` → `enable_hybrid_video_transcoding`, `enable_hybrid_video_transcoding_for_valid_mp4`, `web_channel_video_server_transcode_upload` (HIGH)

---

## A13. Stickers

`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.StickerMessage`, `StickerPackMessage`, `StickerSyncRMRMessage`; `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.StickerMetadata` — fields `Url, FileSha256, FileEncSha256, MediaKey, Mimetype, Height, Width, DirectPath, FileLength, Weight, LastStickerSentTs, IsLottie` (HIGH)

`named_types.txt` → `[WhatsApp.Core] StickerType` (HIGH), 20 values:
`Unknown=0, Arrow=1, Oval=2, Rect=3, ThinkingBubble=4, SpeechBubbleOval=5, SpeechBubbleRect=6, DigitalClock=7, AnalogClock=8, Location=9, AddYours=10, NormalSticker=11, EmojiSticker=12, Photo=13, Music=14, StatusApi=15, Question=16, QuestionAnswer=17, ReactionSticker=18, Nye2026=19`

`named_types.txt` → `[WhatsApp.Core] StickerAction` (HIGH): `PackDownload=0, Send=1, Delete=2, AddToFavorites=3, RemoveFromFavorites=4, RemoveFromRecents=5`
`named_types.txt` → `[WhatsApp.Core] StickerPackType`, `StickerPackDownload`, `StickerPackDelete`, `StickerPackActions` (HIGH)
`named_types.txt` → `[WhatsApp.Core] StickerSearchOpened`, `StickerSearchProvider`, `StickerSearchResult`, `StickerStoreOpened`, `StickerGetMoreButtonTapped` (HIGH)
`named_types.txt` → `[WhatsApp.Core] StickerSend`, `StickerSendOriginType`, `StickerSendMessageType` (HIGH): `Regular=1, Payments=2, Annotation=3`
`named_types.txt` → `[WhatsApp.Core] StickerSuggestionAction` (HIGH): `Impression=1, Click=2, Send=3`
`named_types.txt` → `[WhatsApp.Core] StickerError`, `StickerErrorType`, `StickerLatency`, `StickerLatencyAction` (HIGH)
`named_types.txt` → `[WhatsApp.Core] MediaType.LottieSticker=60`, `StickerReaction=79` (HIGH)
`abprops_list.txt` → `aura_stickers_enabled`, `aura_stickers_benefit_active`, `aura_stickers_overlay_animation_enabled`, `aura_stickers_preview_max_animation_count`, `stickers_emoji_tagging_enabled`, `giphy_pma_shutoff_enabled` (HIGH)
`abprops_list.txt` → `web_ai_sticker_emission_enabled` (HIGH)

---

## A14. Scheduled messages

`named_types.txt` → `[WhatsApp.Core] ScheduledMessageActionType` (HIGH):
`OpenScheduleDateTimePicker=1, SelectDateTime=2, TapScheduleButton=3, TapUnscheduleButton=4, ViewScheduledMessageList=5`

`named_types.txt` → `[WhatsApp.Core] ScheduledMessageEntrypoint` (HIGH): `SystemMessage=1, ChatInfo=2, ChatDeleteDialog=3`
`named_types.txt` → `[WhatsApp.DataModels] WhatsApp.Data.WaScheduledTask` (HIGH) — fields `TaskID, TaskType, LookupKey, Jid, DbJid, BinaryData, Attempts, AttemptsLimit, ExpirationUtc, Restriction, IsDeleted, IsExpired, IsAttemptsLimitReached`

---

## A15. Disappearing messages

`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.EphemeralSetting` — `Duration`, `Timestamp`; `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.DisappearingMode` — `initiator`, `trigger`, `InitiatorDeviceJid`, `InitiatedByMe` (HIGH)
`named_types.txt` → `[WhatsApp.Core] DisappearingModeEntryPointType` (HIGH):
`AccountSettings=1, SystemMessage=2, IndividualChatDisappearingMessagesSetting=3, GroupChatDisappearingMessagesSetting=4, DeepLink=5, StorageSettings=6, PrivacySettings=7`
`named_types.txt` → `[WhatsApp.Core] DisappearingModeSettingChange`, `DisappearingModeSettingEventNameType`, `DisappearingChatInitiatorType`, `DisappearingMessageChatPicker` (HIGH)
`named_types.txt` → `[WhatsApp.Core] EphemeralityInitiatorType` (HIGH): `InitiatedByMe=1, InitiatedByOther=2, BizUpgradeFbHosting=3`
`named_types.txt` → `[WhatsApp.Core] EphemeralSettingChange`, `EphemeralSettingEntryPointType` (HIGH)
`named_types.txt` → `[WhatsApp.Core] PreviousEphemeralityType` (HIGH)

**Native disappearing-timer label (chat header)** — `views.txt` → `EphemeralLabelView` (HIGH); `named_types.txt` → `[WhatsApp.Design] WhatsApp.Design.EphemeralLabelView` (HIGH)

`named_types.txt` → `[WhatsApp.Core] KeepInChatErrors`, `KeepInChatNotif`, `KeepInChatNux`, `KeepInChatPerf`, `DisappearingMessageKeepInChat` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.KeepInChat`, `KeepType` (`UNKNOWN=0, KEEP_FOR_ALL=1, UNDO_KEEP_FOR_ALL=2`) (HIGH)

---

## A16. Message info (delivery/read receipt sheet)

`named_types.txt` → `[WhatsApp.Core] MultideviceActionType` (HIGH): `Login=0, Logout=1, CustomAgentName=2, MessageInfo=3, Active=4, Delete=5`
`named_types.txt` → `[WhatsApp.Core] ChatOpenSource.MessageInfoNavigation=29` (HIGH)
`named_types.txt` → `[WhatsApp.Core] MessageContextMenuOptionType.MessageInfo=11` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.UserReceipt` (HIGH)
`named_types.txt` → `[WhatsApp.Core] ReceiptAggregationType`, `ReceiptStanzaStage` (HIGH)
`named_types.txt` → `[WhatsApp.Core] LastMessageDirection` (HIGH)

---

## A17. Groups, subgroups, communities

`named_types.txt` → `[WhatsApp.Core] ChatActionChatType` (HIGH): `Individual=1, Group=2, Business=3, BroadcastList=4, Channel=5`
`named_types.txt` → `[WhatsApp.Core] UIActionChatType` (HIGH): `Individual=1, Group=2, Subgroup=3, DefaultSubgroup=4, Channel=5, MetaAI=6, AICharacters=7`
`named_types.txt` → `[WhatsApp.Core] CommunityUIFeatureType` (HIGH): `SubgroupSwitch=1`
`named_types.txt` → `[WhatsApp.Core] CommunityCreationActionTakenType` (HIGH), 22 entries:
`Enter=1, GetStarted=2, Dismiss=3, Next=4, CreateGroup=5, LinkGroup=6, CreateCommunity=7, Exit=8, UnlinkGroup=9, CreateCommunitySuccess=10, CreateCommunityFail=11, HelpIconClick=12, LinkGroupConfirmationOk=13, LinkGroupConfirmationCancel=14, NewCommunity=15, ExistingCommunity=16, AddSubgroupAsCadmin=17, SuggestSubgroupAsMember=19, Cancel=20, AddGroupToExistingCommunityFail=21, AddGroupToExistingCommunitySuccess=22`
`named_types.txt` → `[WhatsApp.Core] CommunityCreationCurrentScreenType` (HIGH), 14 entries
`named_types.txt` → `[WhatsApp.Core] CommunityFeatureUsage`, `CommunityHomeAction`, `CommunityTabAction`, `CommunityExitExperienceOrigin`, `NewCommunityExitDialogInteractions`, `OldCommunityExitDialogInteractions`, `CommunityRichSystemMessageClick` (HIGH)
`named_types.txt` → `[WhatsApp.Core] GroupInfoSettingType`, `GroupInfoEntryPoint`, `GroupRoleType`, `GroupProfileActionType`, `GroupSafetyCheckUIInteractions`, `GroupSuspiciousChatBannerType` (HIGH)
`named_types.txt` → `[WhatsApp.Core] GroupMemberUpdates`, `GroupMemberTagUpdate`, `GroupMemberTagEntryPointType` (HIGH) — member tag / name tag feature.
`abprops_list.txt` → `group_member_updates_usernames_enabled`, `group_member_updates_usernames_ui_enabled`, `member_name_tag_receiver_enabled`, `member_name_tag_sender_enabled`, `member_name_tag_db_enabled` (HIGH)

**Native group safety-check exit dialog** — `views.txt` → `PsGroupSafetyCheckExitDialog` (HIGH)

**Group history (new members see old messages)** — `abprops_list.txt` → `group_history_receive`, `group_history_send`, `group_history_settings`, `group_history_settings_toggle_ui`, `group_history_receiver_floating_banner`, `group_history_notice_receive`, `group_history_message_count_limit` (HIGH)

---

## A18. Drafts

`named_types.txt` → `[WhatsApp.Core] TextMessageUserJourneyAction.DraftSaved=4`, `DraftLoaded=8` (HIGH)
`named_types.txt` → `[WhatsApp.Core] PttMessageUserJourneyAction.DraftSaved=9`, `DraftLoaded=10` (HIGH)
`named_types.txt` → `[WhatsApp.Design] WhatsApp.DraftPreviewInChatListState` (HIGH) — a draft preview is rendered in the chat list.
`named_types.txt` → `[WhatsApp.Core] ChatFilterTypes.Drafts=26` (HIGH) — a "Drafts" chat-list filter.
`named_types.txt` → `[WhatsApp.Core] ChatbarInitialState` (HIGH)

---

## A19. In-chat search

`named_types.txt` → `[WhatsApp.Core] InChatSearchAction` (HIGH): `OpenSearch=1, DismissSearch=2, TypeSearchQuery=3, TapUpArrow=4, TapDownArrow=5, OpenTimeSelector=6, SelectTime=7`
`named_types.txt` → `[WhatsApp.Core] InChatSearchUISurface` (HIGH): `ConversationScrollUp=1, OverflowMenu=2, ChatInfo=3`
`named_types.txt` → `[WhatsApp.Core] SearchSelectedMessageSource` (HIGH)
`named_types.txt` → `[WhatsApp.Core] MoreMenuActionType.Search=3` (HIGH)
`named_types.txt` → `[WhatsApp.DataModels] WhatsApp.IMessageSearchInConversationSession`, `WhatsApp.ISearchSession`, `WhatsApp.SearchQuery`, `WhatsApp.TokenField`, `WhatsApp.TokenType` (HIGH)
`named_types.txt` → `[WhatsApp.Core] QuerySearchTypeEnum`, `SearchUjCriteriaType`, `SearchUjItemType`, `SearchUjFilterType` (HIGH)

---

## A20. Reply / quote

`named_types.txt` → `[WhatsApp.Core] QuotedMessageUserJourneyAction` (HIGH):
`QuotedMessageAdded=1, QuotedMessageDeleted=2, QuotedMessageTappedInComposer=3, QuotedMessageBubbleTapped=4, QuotedMessageSent=5, QuotedMessageUpdated=6`
`named_types.txt` → `[WhatsApp.Core] ReplyEntryMethod`, `ReplyExitMethod` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.ContextInfo.QuotedMessage` (HIGH)
`named_types.txt` → `[WhatsApp.Core] MessageContextMenuOptionType.Reply=5`, `ReplyPrivately=6` (HIGH)

---

## A21. Edit, delete, revoke

`named_types.txt` → `[WhatsApp.Core] EditType` (HIGH): `NotEdited=0, Edited=1, SenderRevoke=2, AdminRevoke=3, AdminEdit=4, Pin=5`
`named_types.txt` → `[WhatsApp.Core] EditOutcome` (HIGH): `Completed=1, Canceled=2, Expired=3`
`named_types.txt` → `[WhatsApp.Core] EditEntryPoint`, `EditEventType`, `EditMessageSend`, `EditBusinessProfile` (HIGH)
`named_types.txt` → `[WhatsApp.Core] DeleteActionType` (HIGH): `DeleteForMe=0, DeleteForEveryone=1`
`named_types.txt` → `[WhatsApp.Core] RevokeType` (HIGH): `Sender=0, Admin=1`
`named_types.txt` → `[WhatsApp.Core] UIRevokeActionType` (HIGH): `MessageSelected=0, TrashCanSelected=1, AdminDeleteForEveryone=2, SenderDeleteForEveryone=3, AdminAndSenderDeleteForEveryone=4, DeleteForEveryoneSelected=5`
`named_types.txt` → `[WhatsApp.Core] SnackbarDeleteUndo`, `NewDeleteDialogInteractions` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.EditAddon` — `TimestampMs, Protobuf, AckedRecipientsCount, ServerReceivedTimestamp`; `WhatsApp.ProtoBuf.MessageAddOnContextInfo` — `MessageAddOnDurationInSecs, MessageAddOnExpiryType` (HIGH)
`abprops_list.txt` → `cross_device_message_editing` (HIGH)

---

## A22. Reactions

`named_types.txt` → `[WhatsApp.Core] ReactionActionType` (HIGH): `OpenTray=1, Delete=2, Update=3`
`named_types.txt` → `[WhatsApp.Core] ReactionActions`, `ReactionUserJourney`, `ReactionUserJourneyAction`, `ReactionUserJourneyEntryPoint`, `ReactionDaily` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.ReactionMessage`, `EncReactionMessage`, `ReactionMessageProperties` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.PositronReaction` — `Id, ParentMsgKey, ReactionText, Timestamp, SenderUserJid` (HIGH)
`named_types.txt` → `[WhatsApp.DataModels] WhatsApp.Data.Message.Reactions`, `ReactionsCount` (HIGH)
`named_types.txt` → `[WhatsApp.Core] MediaViewerActionType.SetReactionEmoji=21`, `ViewReactions=22` (HIGH)
`abprops_list.txt` → `reactions_receiver_enabled` (HIGH)

**Native reaction tray (VoIP)** — `views.txt` → `VoipReactionsTrayView`, `VoipReactionsTrayListView` (HIGH)

---

## A23. Star, pin, keep

`named_types.txt` → `[WhatsApp.Core] StarMessage`, `StarMessageEntryPoint`, `ViewStarredMessages`, `ViewStarredMessagesEntryPoint` (HIGH)
`named_types.txt` → `[WhatsApp.Core] PinInChatType` (HIGH): `PinForAll=1, UnpinForAll=2`
`named_types.txt` → `[WhatsApp.Core] PinInChatInteractionType` (HIGH): `TapOnBanner=1, TapOnSystemMessage=2, Impression=3, Expand=4, RowTap=5, ContextMenuOpen=6, Collapse=7`
`named_types.txt` → `[WhatsApp.Core] PinInChatInteraction`, `PinInChatMessageSend`, `PinInChatProperties` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.PinInChat` — `type, Key, SenderTimestampMs, ServerTimestampMs, MessageAddOnContextInfo` (HIGH)
`named_types.txt` → `[WhatsApp.DataModels] WhatsApp.Data.Message.IsStarred`, `KeepInChat`, `IsPinned` (HIGH)
`named_types.txt` → `[WhatsApp.Core] PinnedChats`, `PinnedChatsMaxAlert`, `PinnedChatsPremiumStatusType` (HIGH)
`abprops_list.txt` → `group_history_out_of_window_pin_sender`, `group_history_out_of_window_pins_receiver` (HIGH)

---

## A24. Chat-list and chat-header surfaces

`named_types.txt` → `[WhatsApp.Core] ChatActionType` (HIGH): `Mute=1, Unmute=2, Archive=3, Clear=4, ExitGroup=5, Delete=6, Pin=7, Unread=8, Read=9, SuspendChatDelete=10`
`named_types.txt` → `[WhatsApp.Core] ChatType` (HIGH): `Individual=1, Smb=2, Ent=3, Interop=4, Unknown=5, Business=6`
`named_types.txt` → `[WhatsApp.Core] ChatMutedType` (HIGH): `NotMuted=1, MutedNoNotifications=2, MutedSilentNotifications=3`
`named_types.txt` → `[WhatsApp.Core] ChatMuteNotificationChoice` (HIGH): `NoNotificationsWhenMuted=1, YesNotificationsWhenMuted=2`
`named_types.txt` → `[WhatsApp.Core] ChatsFolderType` (HIGH): `Inbox=1, Archived=2, BusinessFolder=3`
`named_types.txt` → `[WhatsApp.Core] ArchiveChatAction`, `ArchiveSettings`, `ArchiveStateDaily`, `UnarchiveChatsSetting` (HIGH)
`named_types.txt` → `[WhatsApp.Core] ChatLockActionType` (HIGH), 18 entries: `ChatInfoImpression, LockChatScreenImpression, AuthInitiated, AuthSucceeded, SetUpAuthImpression, AddChatLock, RemoveChatLock, ClearAndUnlockImpression, ClearAndUnlockSuccess, ClearAndUnlockFailure, AuthFailure, BottomSheetImpression, BottomSheetContinueClick, BottomSheetLearnMoreClick, FolderOpen, ForgotSecretCode, UnlockAndClearWarning, UseSecretCodeAuth`
`named_types.txt` → `[WhatsApp.Core] ChatLockErrorType` (HIGH), 15 entries; `ChatLockSupportLevel`, `ChatLockSecretCode`, `ChatLockErrors`, `ChatLockErrorSurface` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.ChatLockSettings` — `HideLockedChats`, `SecretCode` (HIGH)
`named_types.txt` → `[WhatsApp.Core] ChatWallpaperType` (HIGH): `Light=1, Dark=2, Solid=3, Custom=4, Default=5`
`named_types.txt` → `[WhatsApp.Core] ChatThemeEntryType` (HIGH): `OneToOne=1, Group=2, AppWide=3, AppTheme=4, ListTheme=5`
`named_types.txt` → `[WhatsApp.Core] ChatThemeScreen`, `ChatThemesBannerActionType`, `ChatThreadThemesNuxBanner` (HIGH)
`named_types.txt` → `[WhatsApp.Core] ChatCustomImageWallpaper`, `ChatDefaultWallpaper`, `ChatSolidColorWallpaper`, `ChatStockImageWallpaper`, `ChatListWallpaper`, `ChatThreadWallpaper`, `ChatWallpaperEntryType` (HIGH)
`named_types.txt` → `[WhatsApp.Core] ChatExport` (HIGH) — export chat to a file.
`named_types.txt` → `[WhatsApp.Core] LabelOperations`, `LabelTargets`, `LabelSyncTypeEnum`, `BusinessFolderAction` (HIGH) — labels/folders.
`named_types.txt` → `[WhatsApp.Core] ChatPsaAction`, `ChatPsaRead`, `ChatPsaRemove`, `ChatPsaTryIt` (HIGH) — PSA / verified-business chats.
`named_types.txt` → `[WhatsApp.Core] ChatAssignmentActionType` (HIGH): `ActionAssigned=0, ActionUnassigned=1, ActionReassigned=2` — business chat assignment.
`named_types.txt` → `[WhatsApp.Core] ChatbarInitialState`, `ChatGatedReason`, `ChatMessageCounts`, `ChatDisplayNameResolutionSummary` (HIGH)

**Native chat-header widgets** — `views.txt` → `NotificationControlsView`, `NotificationStateView` (HIGH) — mute/notification state in the header.

---

# Section B — Media editing

**Important caveat:** in 2.2640.100.0 the *editing UI* (crop canvas, draw surface, meme generator) lives inside the WebView2 app and is therefore **not visible in the DLL type lists**. What the artifacts do contain is (a) the native media-processing surface, (b) the telemetry enum names, and (c) the protocol types. Items are marked MEDIUM when only a name exists.

## B1. Image processing (native)

`named_types.txt` → `[WhatsApp.Core] WamediaImgopsType` (HIGH), 9 values:
`Check=0, Repair=1, RemoveExif=2, InsertMetadata=3, RetrieveMetadata=4, ThumbnailCheck=5, ThumbnailExtract=6, ThumbnailCreate=7, KsCheck=8`

`named_types.txt` → `[WhatsApp.Core] WamediaImgopsImpl`, `WamediaImgopsEvent`, `WamediaImgopsFileType` (HIGH)
`named_types.txt` → `[WhatsApp.Core] WamediaMp4opsType`, `WamediaMp4opsImplEnum`, `WamediaMp4opsFileType`, `WamediaMp4opsAudioStreamType`, `WamediaMp4opsVideoStreamType` (HIGH) — native MP4 mux/demux.
`named_types.txt` → `[WhatsApp.Root] WhatsApp.ImageUtils`, `WhatsApp.JpegUtils`, `WhatsApp.VideoUtils` (HIGH)
`abprops_list.txt` → `enable_lanczos_upscaler_for_photos_bitmap`, `enable_lanczos_upscaler_for_vod_bitmap`, `lanczos_min_upscale_scale_for_vod`, `kaleidoscope_thumbnail_validation`, `wa_media_image_upload_cache` (HIGH) — HD photo upscaling and thumbnail handling.
`abprops_list.txt` → `enable_rx_video_enhance_chat_fullscreen`, `rx_video_enhance_max_short_edge_px`, `rx_video_enhance_sharpen_strength_x1000` (HIGH)

## B2. Rotate

`named_types.txt` → `[WhatsApp.Core] MediaViewerActionType.Rotate=12` (HIGH) — rotate is a media-viewer action.
`named_types.txt` → `[WhatsApp.Root] ABI.WinRTAdapter.IWamGlobalCallbacks.OnRotateRequested` (HIGH) — the native side receives an explicit **rotate** request from the web app.

## B3. Crop

`named_types.txt` → `[WhatsApp.Core] ChatFilterActionTypes` contains `AICreationAvatarCropClick=196`, `AICreationAvatarCropDone=197` (HIGH) — a **crop tool exists** (confirmed for the AI-avatar creation flow).
**MEDIUM:** general media crop for chat attachments is inferred, not directly evidenced. The `MediaViewerActionType` list has `Edit=5` but no explicit `Crop` entry.

## B4. Draw / markup / annotation

`named_types.txt` → `[WhatsApp.Core] StickerSendMessageType.Annotation=3` (HIGH) — stickers can be sent with an annotation layer.
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.InteractiveAnnotation` — fields `PolygonVertices, Location, Newsletter, EmbeddedAction, TapAction, ShouldSkipConfirmation, EmbeddedContent, status_link_type`; `WhatsApp.GProtoBuf.InteractiveAnnotation` (HIGH) — polygon annotation points on media.
`named_types.txt` → `[WhatsApp.Core] MediaCanvasSend` (HIGH) — a **canvas send** path exists (drawing → image).
`named_types.txt` → `[WhatsApp.Core] AIRichResponseMapAnnotation` (HIGH) — map annotation in AI rich responses.
`named_types.txt` → `[WhatsApp.Core] WhatsApp.Data.Message.MediaCaption` (field) + `[WhatsApp.Core] VideoEventType.CaptionChange=4` (HIGH) — caption is editable during playback.

## B5. Sticker creation (sticker maker)

`named_types.txt` → `[WhatsApp.Core] StickerMakerAction` (HIGH): `Open=1, Send=2, AddToPack=3, Error=4`
`named_types.txt` → `[WhatsApp.Core] StickerMakerMediaType` (HIGH): `Image=1, Video=2, Gif=3`
`named_types.txt` → `[WhatsApp.Core] StickerMakerSourceType` (HIGH): `CutoutImage=1, WebStickerMaker=2, IosStickerMaker=3, AndroidStickerMaker=4, TransparentImage=5, Gif=6`
`named_types.txt` → `[WhatsApp.Core] MediaViewerActionType.CreateSticker=9` (HIGH)
`named_types.txt` → `[WhatsApp.Core] AIStickerFetch`, `AIStickerSend`, `AIStickerIntegrityReport`, `AIStickerLatency` (HIGH)

## B6. Video trimming

`named_types.txt` → `[WhatsApp.Core] MediaOperation` (HIGH): `Transcode=1, Trim=2, CheckAndRepair=3` — **trim is an explicit media operation** in the real app.
`named_types.txt` → `[WhatsApp.Core] MediaActionPipelinePerf`, `MediaTranscode`, `MediaTranscodeAlgorithmType` (HIGH)
`named_types.txt` → `[WhatsApp.Root] WhatsApp.SystemIntegrations.MediaTranscodingService`, `WhatsApp.NativeTranscodeWrapper`, `WhatsApp.Media.ITranscoder` (HIGH)
`abprops_list.txt` → `enable_hybrid_video_transcoding`, `enable_hybrid_video_transcoding_for_valid_mp4` (HIGH)

## B7. Caption editing

`named_types.txt` → `[WhatsApp.Core] VideoEventType.CaptionChange=4` (HIGH) — caption change is a tracked video event.
`named_types.txt` → `[WhatsApp.DataModels] WhatsApp.Data.Message.MediaCaption` (HIGH) — caption is a first-class message field.
**MEDIUM:** whether caption editing is available for every media type, or only for video, is not determinable from the artifacts.

## B8. AR / visual effects (filters, background blur, retouch)

`named_types.txt` → `[WhatsApp.Core] EffectCategory` (HIGH): `None=0, PersonalizedAvatar=1, PresetAvatar=2, Touchup=3, Lowlight=4, Background=5, Filter=6, Fun=7`
`named_types.txt` → `[WhatsApp.Core] EffectStartReason`, `EffectEndReason`, `EffectLoadingResultType`, `EffectLoadingFailedReason` (HIGH)
`named_types.txt` → `[WhatsApp.Core] RetouchDisableReason` (HIGH): `None, UserDisabled, MlInferenceError, IgluRenderError, ModelLoadFailure, HighLatency, UnsupportedDevice, ThermalThrottle, Other`
`named_types.txt` → `[WhatsApp.Core] PresetType` (HIGH) — 15 "About" presets (FreeToChat, Traveling, AtTheGym, …) i.e. profile "mood" presets.
`named_types.txt` → `[WhatsApp.Core] StatusMediaPickerFormatType`, `StatusPairedMediaQuality` (HIGH)

## B9. Items NOT found in the artifacts

Searched `named_types.txt`, `features.txt`, `abprops_list.txt` for: `Meme`, `Markup`, `Doodle`, `Watermark`, `Overlay`, `Tattoo`.

- **Meme generator — NOT FOUND.** No type, flag, or event mentions a meme feature.
- **Text-overlay / meme markup tool — NOT FOUND** as a named feature.
- **Drawing mode as a chat composer tool — MEDIUM only** (`MediaCanvasSend`, `StickerSendMessageType.Annotation`).
- **General photo crop in the media viewer — MEDIUM** (crop confirmed only for AI-avatar creation).

---

# Section C — Richer surfaces

## C1. Calls (VoIP)

**Native views** (`views.txt`, HIGH): `VideoCallView`, `AudioCallView`, `CallControlsView`, `CallParticipantItemView`, `AddCallParticipantsView`, `CallLinkBannerView`, `CallEndRatingView`, `CallingErrorsView`, `CallOfferFailedControlsView`, `ParticipantSideBarView`, `CallHistoryListContextMenuFlyout`, `VoipView`, `VoipSelectedUIView`, `VoipDevicesFlyout`, `VoipReactionsTrayView`, `VoipReactionsTrayListView`, `VideoStreamView`, `PipVideoStreamView`, `VideoRequestControlsView`, `VideoRequestCompactView`, `VideoMuteStateBannerView`, `VideoParticipantMuteStateView`, `VideoParticipantStateView`, `CameraSwitchedBannerView`, `MicrophoneSwitchedBannerView`, `PeerVideoPermissionBannerView`, `TimeoutBannerView`, `AudioWaveView`, `AudioParticipantView`

**Call model** — `named_types.txt` → `[WhatsApp.Core] CallActionType` (HIGH), **146 actions**, including:
`TapMute, TapUnmute, TapAddParticipant, StartVoiceChat, RingAll, RejoinVoiceChat, OpenVoiceChatBottomSheet, TurnOnSpeaker, TurnOffSpeaker, TurnOnBluetooth, TurnOffBluetooth, MinimizeCall, TapGoToChat, OpenSearchBar, EndCall, OpenVoiceChatLobby, FlipCamera, TurnOnCamera, TurnOffCamera, SwapSelfView, TapE2ee, OpenFocusView, MuteOtherFocusView, MaximizeCall, TapFavoritesAdd/…/ReorderFavorites, Paginate, Pin, Unpin, SwitchToGalleryView, SwitchToSpeakerView, RemoveUser, TapMore, TurnOnEarpiece, TurnOffEarpiece, TapDialerEntry, TapArEffectsButton, LongPressToOpenArEffects, AdjustZoomLevel, StartScreenShare, TapReaction, TapRaiseHand, TapLowerHand, OpenVideoPicker, OpenAudioPicker, SwitchVideoSourceWearable/Phone, TapParticipant, TapKeepWaiting, TapScreenShare, ToggleNoiseCancellationOn/Off, PresentNativeAudioRoutePicker, TapAddParticipantLgc, PickMetaAIParticipant, MetaAIConnected, ToggleCenterStageOn/Off, ArAttributionBannerShown/ButtonTapped`

`named_types.txt` → `[WhatsApp.Core] CallTermReason` (HIGH), 40 termination reasons
`named_types.txt` → `[WhatsApp.Core] CallResultType` (HIGH), 29 results
`named_types.txt` → `[WhatsApp.Core] CallSetupErrorType` (HIGH), 28 setup errors
`named_types.txt` → `[WhatsApp.Core] CallTransportType` (HIGH): `Unknown=0, P2p=1, UdpRelay=2, TcpRelay=3, Mixed=4`
`named_types.txt` → `[WhatsApp.Core] CallStanzaType` (HIGH): `Offer, Accept, Reject, Video, Terminate, EncRekey, Relaylatency, Transport, Preaccept, GroupUpdate, MuteV2, Interruption, Flowcontrol, Notify, OfferNotice, CallRelay, Mute, ScreenShare, Unknown`
`named_types.txt` → `[WhatsApp.Core] CallVideoState` (HIGH): `Disabled, Enabled, Paused, UpgradeRequest, Muted, UnknownPeer, Xr2DCodecAvatarEnabled, Error`
`named_types.txt` → `[WhatsApp.Core] CallSizeType` (HIGH): `OneToOne=1, Adhoc=2, Lgc=3, CallLink=4`
`named_types.txt` → `[WhatsApp.Core] CallType` (HIGH): `REGULAR=0, SCHEDULED_CALL=1, VOICE_CHAT=2`
`named_types.txt` → `[WhatsApp.Core] CallLinkType` (HIGH): `Standard=1, Event=2`
`named_types.txt` → `[WhatsApp.Core] CallLinkMedia` (HIGH): `Voice=1, Video=2`
`named_types.txt` → `[WhatsApp.Core] CallLinkShareChatType` (HIGH): `Individual, Business, GroupLarge, Group3P, Group8P, Group32P`
`named_types.txt` → `[WhatsApp.Core] CallFromUI` (HIGH), 90 entry points
`named_types.txt` → `[WhatsApp.Core] EndCallConfirmationType`, `CallWakeupSource`, `CallNetworkMedium`, `CallRelayBindStatus`, `CallInitiatorType`, `CallDirection`, `CallStatus` (HIGH)
`named_types.txt` → `[WhatsApp.Core] LobbyEntryPointType` (HIGH), 44 entry points; `LobbyExitType` (HIGH), 14 exits
`named_types.txt` → `[WhatsApp.Core] PushGhostCallReason`, `UnansweredCallAction`, `UnansweredCallReasonType`, `UnansweredCallUISourceType`, `UnansweredCallUserActionType` (HIGH)

**Call-link / scheduled call flags** (`abprops_list.txt`, HIGH): `enable_hybrid_call_links_creation`, `enable_hybrid_call_links_join`, `enable_call_links_push_notification`, `enable_call_link_call_log_aggregation`, `enable_lid_call_link`, `enable_new_call_link_representation`, `enable_auto_add_call_link_creator`, `schedule_call_show_join_button_time_interval_mins`, `schedule_call_show_upcoming_banner_time_interval_mins`

**Call history** — `named_types.txt` → `[WhatsApp.Models] WhatsApp.CallRecord`, `WhatsApp.CallRecordType`, `WhatsApp.CallLogEntryParticipant` (HIGH)

## C2. Screen share

`views.txt` → `ScreenShareTileView`, `ScreenShareFirstTimeView`, `ScreenShareFrictionView`, `ScreenShareAppUpdateDialog` (HIGH)
`named_types.txt` → `[WhatsApp.Root] WhatsApp.ScreenShareFirstTimeVm`, `WhatsApp.ScreenShareFrictionVm` (HIGH)
`named_types.txt` → `[WhatsApp.Core] ScreenShareFrictionDialogType` (HIGH): `ScreenShareFriction=0, ScreenSharePrivate=1`
`named_types.txt` → `[WhatsApp.Core] ScreenShareFrictionUIAction` (HIGH): `Open, Dismiss, ContinueTapped, CancelTapped`
`named_types.txt` → `[WhatsApp.Core] ScreenShareFrictionScreenShareInitiator` (HIGH): `Caller=0, Callee=1`
`named_types.txt` → `[WhatsApp.Core] ScreenShareFrictionCallType` (HIGH)
`named_types.txt` → `[WhatsApp.DataModels] WhatsApp.ScreenShareBannerType` (HIGH)
`named_types.txt` → `[WhatsApp.Core] CallActionType.StartScreenShare=86`, `TapScreenShare=110`, `ScreenShareTooltipPresented=64`, `ScreenShareTooltipDismissedTimeout=67`, `ScreenShareTooltipDismissedButtonTap=70` (HIGH)
`named_types.txt` → `[WhatsAppNativeProjection] WhatsAppNative.Voip.ScreenShareEvent`, `ScreenShareErrorType`, `ScreenShareEndReason`, `ScreenShareDeviceStats`, `ScreenSharerInfo` (HIGH)
`abprops_list.txt` → `call_screen_share_dual_stream_app_update_dialog_enabled`, `calling_screen_share_milestone_version`, `enable_uwp_screen_share_teaching_tip`, `enable_uwp_share_any_window`, `show_integrity_screensharing_friction_ui`, `max_num_participants_for_ss`, `windows_ss_capture_driver_type` (HIGH)

## C3. Waiting room / lobby

`views.txt` → `WaitingRoomRequestsBannerView`, `WaitingRoomUserItemView` (HIGH)
`named_types.txt` → `[WhatsApp.DataModels] WhatsApp.WaitingRoomFilter`, `WhatsApp.WaitingRoomFilterExtensions` (HIGH)
`abprops_list.txt` → `enable_waiting_room_ui`, `enable_waiting_room_admin_ui`, `enable_waiting_room_logging`, `lobby_timeout_min`, `web_guest_calling_waiting_room_admin_xp_enabled`, `web_guest_calling_waiting_room_approval_note_enabled` (HIGH)
`named_types.txt` → `[WhatsApp.Core] CallTermReason.WaitingRoomDenied=32`, `WaitingRoomTimeout=33` (HIGH)

## C4. Raise hand / reactions in call

`abprops_list.txt` → `hand_raise_receiver_enabled`, `disable_raise_hand_1on1`, `enable_new_user_action_stanza_for_raise_hand_sender` (HIGH)
`named_types.txt` → `[WhatsApp.Core] CallActionType.TapRaiseHand=89`, `TapLowerHand=90`, `TapReaction=87` (HIGH)

## C5. Linked devices

`named_types.txt` → `[WhatsApp.Core] MDLinkDeviceCompanion`, `MDLinkDeviceCompanionStage`, `MDLinkDeviceQrScan`, `MDLinkDeviceQrScanResultType`, `MDLinkedDevicesWindowsXdr`, `MDLinkedDevicesWindowsXdrStage` (HIGH)
`named_types.txt` → `[WhatsApp.Core] DeviceLinkWarningDialogType`, `DeviceLinkWarningDialogInteraction`, `DeviceLinkWarningUIAction` (HIGH)
`named_types.txt` → `[WhatsApp.Core] CompanionGetDevicesList`, `DeviceConnectionState`, `DeviceType` (HIGH)
`named_types.txt` → `[WhatsApp.Core] BackupRestoreApi`, `BackupRestoreStage`, `BackupRestoreType`, `BackupNetworkSetting` (HIGH)
`abprops_list.txt` → `enable_windows_xdr_chat_handoff`, `enable_windows_xdr_wns_pkey`, `enable_uwp_device_switch_banner`, `device_switching_enabled`, `adv_accept_hosted_devices`, `max_number_of_frequently_used_contacts_shared_with_device`, `max_number_of_recent_contacts_shared_with_device` (HIGH)
`named_types.txt` → `[WhatsApp.Core] AppLaunchPeripheralLinked` (HIGH)

## C6. Privacy

`named_types.txt` → `[WhatsApp.Core] PrivacyControlItemType` (HIGH) — **32 privacy controls**:
`LastSeenAndOnline=0, ProfilePhoto=1, About=2, Groups=3, Status=4, ReadReceipt=5, Blocked=6, LiveLocation=7, ScreenLock=8, DdmTimer=9, Calls=10, FingerprintLock=11, DisappearingMessages=12, Unknown=13, Checkup=14, ShowPreview=15, E2eeBackups=16, TwoStepVerification=17, FaceAndHandEffects=18, Advanced=19, ChatLock=20, Avatar=21, Contacts=22, PrivacyCheckup=23, Pix=24, DefenseMode=25, ProfileLinks=26, Passkey=27, Email=28, Channels=29, CoverPhoto=30, GroupCreation=31`

`named_types.txt` → `[WhatsApp.Core] PrivacyCheckupSurface` (HIGH): `Landing, Contact, PersonalInfo, ChatPrivacy, AccountProtection`
`named_types.txt` → `[WhatsApp.Core] PrivacyCheckupItemClicked` (HIGH), 17 entries
`named_types.txt` → `[WhatsApp.Core] PrivacyControlEntryPointType` (HIGH), 12 entries
`named_types.txt` → `[WhatsApp.Core] PrivacyHighlightSurfaceEnum` (HIGH), 13 entries
`named_types.txt` → `[WhatsApp.Core] PrivacySettingsValueType`, `PrivacySettingsContactsBuckets`, `PrivacyCheckupAction`, `PrivacyCheckupSource`, `PrivacyAlertCase`, `PrivacyAlertCategory` (HIGH)
`named_types.txt` → `[WhatsApp.Core] DefenseModeClickControlName`, `DefenseModeClickDesiredState`, `DefenseModeQuarantineAction` (HIGH)
`abprops_list.txt` → `privacy_screen_enabled`, `privacy_settings_about_lid_migration_enable`, `privacy_settings_group_add_lid_migration_enable`, `privacy_settings_profile_lid_migration_enable`, `privacy_settings_stickers_lid_migration_enable`, `defense_mode_available`, `defense_mode_quarantine` (HIGH)

## C7. Payments

`named_types.txt` → `[WhatsApp.Core] PaymentActionTargets` (HIGH) — **379 distinct payment UI targets** (a full map of the payments UI: `SendPaymentButton, AcceptPayment, PayCollectRequest, DeclineCollectRequest, ScanPaymentQrCodeButton, MyCodeButton, ShareButton, PayNow, AmountPay, PixKey, PixName, UpiId, SplitExpenseButton, ModifyTotalAmount, ModifyIndividualAmount, PaymentComposer, PasskeyToggleOn/Off, SetupPinButton, …`).
`named_types.txt` → `[WhatsApp.Core] PaymentActionTypes` (HIGH): `View=0, Click=1, Enter=2, Api=3, ShowError=4`
`named_types.txt` → `[WhatsApp.Core] PaymentModeTypes` (HIGH): `Consumer=0, Merchant=1`
`named_types.txt` → `[WhatsApp.Core] PaymentsIqCall`, `PaymentsRequestNameType`, `PaymentsResponseResultType`, `PaymentsUpiCheckPinUserErrorReasonType`, `PaymentsVerifyCardResultType`, `PaymentTransactionStatusType`, `PaymentsContactsBucketType` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.SendPaymentMessage`, `RequestPaymentMessage`, `CancelPaymentRequestMessage`, `DeclinePaymentRequestMessage`, `SplitPaymentMessage`, `SplitPaymentParticipant`, `PaymentInviteMessage`, `PaymentReminderMessage`, `PaymentLinkMetadata`, `PaymentLinkButton`, `PaymentLinkHeader`, `PaymentLinkProvider`, `PaymentExtendedMetadata`, `InvoiceMessage` (HIGH)
`named_types.txt` → `[WhatsApp.Core] QuickReplyType` (HIGH): `QuickReplyTypePixKey, QuickReplyTypeShareUpiQr, QuickReplyTypeSetupUpiQr, QuickReplyTypePaymentKey, QuickReplyTypeRequestContactInfo`
`abprops_list.txt` → `payments_br_p2m_pix_copy_code_buyer_logging`, `payments_br_p2m_pix_in_groups_buyer_logging`, `payments_br_p2p_pix_copy_code_buyer_logging`, `payments_br_payment_links_buyer_logging`, `payments_br_pix_on_web` (HIGH)

## C8. Business / catalog / orders

**Native views** (`views.txt`, HIGH): `BizCatalogView`, `BizIgPostsView`, `BizProfileView`, `CatalogCategoryView`, `CommercePerfView`
`named_types.txt` → `[WhatsApp.Core] CatalogViewAction` (HIGH), 55 entries incl. `ActionCartAddProduct, ActionCartEditProduct, ActionCartDeleteProduct, ActionCartAbandon, ActionSendOrderMessage, ActionOrderListImpression, ActionProductInConversationClick, ActionQuotedProductInConversationClick, ActionShareCatalogCopyLinkClick, ActionWatchProductVideo, ActionPlpProductVariantChange, ActionPlpBottomSheetSeeMoreDetails`
`named_types.txt` → `[WhatsApp.Core] CatalogBizAction` (HIGH), 95 entries (product CRUD, collections, appeal, advertise-to-status)
`named_types.txt` → `[WhatsApp.Core] CatalogEntryPoint` (HIGH), 26 entries; `CatalogType`, `BizCatalogType` (HIGH)
`named_types.txt` → `[WhatsApp.Core] OrderStatus`, `OrderSurface`, `OrderSignalType`, `OrderDetailsCreationAction`, `OrderDetailsActionsSmb` (HIGH)
`named_types.txt` → `[WhatsApp.Core] BusinessTemplateBookingStatus`, `BusinessTemplatePaymentReminder`, `BusinessTemplateRichOrderStatus`, `BusinessTemplateCallingStats`, `BusinessTemplateMessageReplyStats` (HIGH)
`named_types.txt` → `[WhatsApp.Core] BusinessToolsLinkedAccountType`, `BusinessHomeDotStatus`, `BusinessFolderAction`, `BusinessMute`, `BusinessUnmute`, `CreateBizProfile`, `EditBusinessProfile` (HIGH)
`named_types.txt` → `[WhatsApp.Core] SmbFeatureNameEnum`, `SmbListFeatureNameType`, `SmbDataSharingConsentSetting`, `SmbPerCustomerDataSharingControlAction` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.ProductMessage`, `OrderMessage`, `ProductListInfo`, `ProductSection`, `CatalogSnapshot`, `ProductSnapshot` (HIGH)

## C9. Meta AI / AI features

`named_types.txt` → `[WhatsApp.Core] MetaAIActionEntryPoint` (HIGH): `ThreeDotMenu=1, ThreadListView=2, TopNav=3, ChatList=4, NavigationBarButton=5, ContinueChatModule=6`
`named_types.txt` → `[WhatsApp.Core] MetaAIModelTierType` (HIGH): `Base=0, Premium=1`
`named_types.txt` → `[WhatsApp.Core] MetaAIUpsellCta`, `MetaAIUpsellCtaOperationType`, `MetaAIUpsellCtaSourceType`, `MetaAIWidgetEvent` (HIGH)
`named_types.txt` → `[WhatsApp.Core] AIChatEntryPoint`, `AIChatOriginsType`, `AIFeatureEntryPoint`, `AIFetchMediaType`, `AIStickerFetch`, `AIStickerSend` (HIGH)
`named_types.txt` → `[WhatsApp.Core] AIThreadType`, `AIThreadsUserJourney`, `AIResponseActionTypes`, `AIResponseViewedMomentType` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.AIRichResponseMessage`, `AIRichResponseContentItemMetadata`, `AIRichResponseLatexExpression`, `AIRichResponseMapAnnotation`, `AIRichResponseReelItem`, `AIRichResponseTableRow`, `AIRichResponseCodeBlock`, `WhatsApp.GProtoBuf.AIRichResponseUnifiedResponse` (HIGH)
`named_types.txt` → `[WhatsApp.Core] PrivateAIFeatureName` (HIGH): `Summarization, WriteWithAI, Psi, QuickRecap, Incognito, SideChat, GroupAI, PsiSearch`
`named_types.txt` → `[WhatsApp.Core] PrivateAIActionType` (HIGH), 120 actions (rewrite, summarize, incognito, side chat, capabilities, imagine, suggestions)
`named_types.txt` → `[WhatsApp.Core] PrivateAICommandType` (HIGH): `Summarize=0, Write=1, Imagine=2, Search=3`
`named_types.txt` → `[WhatsApp.Core] SideChatDragHandlePosition` (HIGH) — side-chat panel.
`named_types.txt` → `[WhatsApp.Core] MessageContextMenuOptionType.AskMetaAI=28` (HIGH) and `MediaViewerActionType.TapAskMetaAI=30` (HIGH) — "Ask Meta AI" on a message and on media.
`abprops_list.txt` → `ai_search_experience_enabled`, `ai_search_meta_ai_send_button_enabled`, `ai_chat_meta_ai_banner_m2_enabled`, `ai_groups_open_enabled`, `ai_rich_response_forward_receiving_enabled`, `ai_search_bar_2025_redesign_enabled`, `ai_simplified_profile_page_enabled`, `ai_bot_integration_enabled`, `ai_3p_agent_media_support_mode`, `ai_hatch_integration_tab_enabled`, `voice_ai_conversation_starter_latency_tracking` (HIGH)
`abprops_list.txt` → `web_ai_sticker_emission_enabled`, `ai_asset_replacement_enabled` (HIGH)

## C10. Channels (newsletters)

`named_types.txt` → `[WhatsApp.Core] ChannelMenuItemType` (HIGH), 17 entries:
`Overflow=0, ChannelInfo=1, Share=2, InviteAdmins=3, AddShortcut=4, Insights=5, ChannelSettings=6, Report=7, Unfollow=8, SelectUpdates=9, CloseChannel=10, OpenInNewWindow=11, ChannelLink=12, Mute=13, Unmute=14, ClearMedia=15, CreateStatus=16`
`named_types.txt` → `[WhatsApp.Core] ChannelEventType` (HIGH), 17 entries: `Follow, Unfollow, Mute, Unmute, PremiumSubscribe, PremiumUnsubscribe, ChannelPremiumSetup, ChannelPremiumCancel, Hide, Unhide, Create, Delete, AdminProfileCreate/Update/Delete, AdminProfileSettingEnable/Disable`
`named_types.txt` → `[WhatsApp.Core] ChannelEventSurface` (HIGH), 9 entries
`named_types.txt` → `[WhatsApp.Core] ChannelDirectory`, `ChannelDirectorySurface`, `ChannelDirectoryAction`, `ChannelSimilarChannels`, `ChannelsInterestPicker`, `ChannelsPrivacySettings`, `ChannelsPrivacyActionType`, `ChannelWaitlist`, `ChannelProducerInsights*` (HIGH)
`named_types.txt` → `[WhatsApp.Core] NewsletterClearMedia`, `NewsletterClearMediaActionType`, `NewsletterClearMediaEntryPointType`, `NewsletterEnforcementEvents` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.NewsletterAdminInviteMessage`, `NewsletterFollowerInviteMessage`, `ForwardedNewsletterMessageInfo`; `[WhatsApp.Core] WhatsApp.NewsletterJid` (HIGH)
`named_types.txt` → `[WhatsApp.Core] ChatEntryPoint` contains 20 newsletter entry points including `NewsletterList, NewsletterLink, NewsletterDeeplink, NewsletterDirectory, NewsletterForwardedMessage, RecommendedNewsletters, NewsletterCategoriesSearch, NewsletterMediaGalleryMedia, NewsletterThreadChainPill, NewsletterThreadChainSwipeUp` (HIGH)
`abprops_list.txt` → `wa_web_channels_migrate_subscribers_to_followers_enabled` (HIGH)

## C11. Status / stories

**Native views** (`views.txt`, HIGH): `StatusItemView`, `StatusRowView`, `StatusPrivacySettingsView`, `AvatarStatusOverlayView`
`named_types.txt` → `[WhatsApp.Core] StatusPrivacyType` (HIGH): `AllContacts=1, Except=2, OnlyWith=3, CloseFriends=4, CustomList=5, GroupStatus=6`
`named_types.txt` → `[WhatsApp.Core] StatusPrivacySettingsAction` (HIGH), 46 entries (audience selection, custom audiences, close-friends lists, group-status picker)
`named_types.txt` → `[WhatsApp.Core] StatusPrivacySettingsView` (HIGH): `SettingsFull=1, SettingsBottomSheet=2, SelectionPills=3`
`named_types.txt` → `[WhatsApp.Core] StatusRowSection` (HIGH), 41 entries
`named_types.txt` → `[WhatsApp.Core] StatusViewerNonTrafficActionType` (HIGH): `Received, Viewed, ForwardTap, MuteTap, ViewContact, MessageTap, HeaderTap, TooltipTap, ButtonTap, ExitPlaybackTapHeaderButton, TookScreenshot`
`named_types.txt` → `[WhatsApp.Core] StatusViewerTrafficActionType` (HIGH): `MessageSend=1, ReactionTap=2, VoiceCallTap=3, VideoCallTap=4, LikeTap=5`
`named_types.txt` → `[WhatsApp.Core] StatusViewActionType` (HIGH): `AttributionTapped, AttributionListOpened, AttributionListItemTapped, QuestionStickerClick, QuestionAnswerSend, ReactionStickerClick, ReshareButtonTap, CloseSharingEmojiClick, UrlClick`
`named_types.txt` → `[WhatsApp.Core] StatusCreationEntryPoint`, `StatusPost`, `StatusPostResult`, `StatusPostOrigin`, `StatusPostImpression`, `StatusArchiveActions`, `StatusTrayExpansionState`, `StatusRankingEntryPoint` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.StatusNotificationMessage`, `StatusQuestionAnswerMessage`, `StatusQuotedMessage`, `StatusStickerInteractionMessage`, `StatusProperties`, `StatusAudienceMetadata`, `StatusAttributionType` (HIGH)

## C12. Community

Covered in A17. Additional:
`named_types.txt` → `[WhatsApp.Core] CommunityRichSystemMessageClickUserType`, `CommunityRichSystemMessageClickRichMessageType` (HIGH)
`named_types.txt` → `[WhatsApp.Core] ChatFilterTypes.Community=24` (HIGH)
`named_types.txt` → `[WhatsApp.Core] GroupHistorySystemMessageType` (HIGH)

## C13. Live location

Covered in A8.

## C14. Nearby / proximity share

`named_types.txt` → `[WhatsApp.Core] NearbyDropShareAction` (HIGH), 26 entries: `IntroNuxImpression, IntroNuxContinueClick, PermissionsGranted, PermissionDenied, QrCodeImpression, ScanQrCodeClick, SearchingForPeer, ConnectingToPeer, SelectFilesSendClick, SendStarted, TransferSucceeded, TransferFailed, TransferCancelled, ScanningFailed`
`named_types.txt` → `[WhatsApp.Core] NearbyDropShareEventPermissionType` (HIGH): `FindAndConnect=0, PhotoVideoAccess=1, CameraAccess=2, TurnOnLocation=3`
`named_types.txt` → `[WhatsApp.Core] NearbyDropShareEventEntryPoint` (HIGH): `Settings=0, ShareSheet=1, NativeCamera=2`
`named_types.txt` → `[WhatsApp.Core] NearbyDropShareEventUser` (HIGH)

## C15. Message translation

`named_types.txt` → `[WhatsApp.Core] TranslationAction` (HIGH): `Translate=1, ViewTranslation=2, RemoveTranslation=3`
`named_types.txt` → `[WhatsApp.Core] MessageTranslation`, `MessageTranslationFeedback`, `TranslationModelType`, `TranslationResult` (HIGH)
`named_types.txt` → `[WhatsApp.Protobuf] WhatsApp.ProtoBuf.HighlyStructuredMessageTranslation` (HIGH)
`named_types.txt` → `[WhatsApp.Core] MessageContextMenuOptionType.Translate=35`, `ViewTranslation=36`, `RemoveTranslation=37` (HIGH)

## C16. Voice-message transcription

`named_types.txt` → `[WhatsApp.Core] TranscriptionRequestType` (HIGH): `UserInitiated=0, Automatic=1, LanguageFetch=2`
`named_types.txt` → `[WhatsApp.Core] TranscriptionResult`, `Transcription`, `TranscriptionDaily`, `TranscriptionFeedback`, `TranscriptionLanguageDownload` (HIGH)
`named_types.txt` → `[WhatsApp.Core] MessageContextMenuOptionType.Speak=36` (HIGH) — "speak" (TTS) on a message.

## C17. Voice notes → text-to-speech and "speak" in chat

`named_types.txt` → `[WhatsApp.Core] VoicemailUserJourney`, `VoicemailUserJourneyActionTypeEnum`, `VoicemailUserJourneySourceTypeEnum` (HIGH)

## C18. Cross-cutting: links, suspicious content, safety

`named_types.txt` → `[WhatsApp.Core] SuspiciousLinkBanner`, `SuspiciousLinkClassified`, `SuspiciousLinkPromptReason`, `SuspiciousLinkSenderRelationship` (HIGH)
`named_types.txt` → `[WhatsApp.Core] GroupSuspiciousChatBannerType`, `OneToOneSuspiciousChatBannerType`, `SuspiciousChatBannerUIAction`, `SuspiciousChatUIButtons`, `SuspiciousChatUITypes` (HIGH)
`named_types.txt` → `[WhatsApp.Core] LinkFrictionFunnel`, `LinkFrictionUIAction` (HIGH)
`named_types.txt` → `[WhatsApp.Root] WhatsApp.Tools.UrlSafetyValidator` (HIGH)
`named_types.txt` → `[WhatsApp.Core] ScreenshotBlocked` (HIGH)

## C19. Cross-cutting: threads / inbox features (WhatsApp 2025+)

`named_types.txt` → `[WhatsApp.Core] ThreadActionTypes`, `ThreadActionEntryPoint`, `ThreadLevelAction`, `TopThreadType`, `ActionThreadTypeType`, `ThreadCreationTime` (HIGH)
`named_types.txt` → `[WhatsApp.Core] DependentMessageRequestFolderEntrypoint`, `DependentMessageRequestFolderOpened` (HIGH) — the "Requests" inbox folder.
`named_types.txt` → `[WhatsApp.Core] InThreadSurveyQuestion`, `InThreadSurveyOption`, `InThreadSurveyPrivacyStatementPart` (HIGH) — in-thread surveys.
`named_types.txt` → `[WhatsApp.Core] InThreadAuthenticationEventType`, `InThreadAuthenticationError`, `InThreadAuthenticationResult` (HIGH)
`named_types.txt` → `[WhatsApp.Core] MessageContextMenuOptionType.AddToNote=34` (HIGH) — "add to note".

---

# Section D — Feature flags (`abprops_list.txt`) most relevant to a chat clone

Full list is 1210 flags. These are the ones that gate chat-surface behaviour:

**Composer / messaging**
`cross_device_message_editing`, `mark_as_verified_enabled`, `message_capping_upsell_version`, `new_chat_msg_capping_first_warning_threshold_percentage`, `wa_individual_new_chat_msg_capping_enabled`, `wa_individual_new_chat_thread_capping_limit`, `wa_capping_local_data_logic_update`, `p2p_pills_enabled`, `p2p_pills_allowlist`, `p2p_pills_auto_send_messages`, `p2p_pills_graphql_enabled`, `p2p_pills_max_wait_on_contact_card_send`, `p2p_pills_new_business_metadata_enabled`

**Polls**
`poll_add_option_creator_enabled`, `poll_add_option_enabled`, `poll_add_option_participant_enabled`, `poll_add_option_receiving_enabled`, `poll_creator_edit_enabled`, `poll_creator_edit_receiving_version`, `poll_end_time_enabled`, `poll_end_time_receiving_enabled`, `poll_hide_voters_enabled`, `poll_hide_voters_receiving_enabled`, `enable_poll_results_contact_info_entry_point`, `enable_poll_settings_label_improved_layout`

**Reactions / stickers / emoji**
`reactions_receiver_enabled`, `aura_stickers_enabled`, `aura_stickers_benefit_active`, `aura_stickers_overlay_animation_enabled`, `aura_stickers_preview_max_animation_count`, `stickers_emoji_tagging_enabled`, `giphy_pma_shutoff_enabled`, `web_ai_sticker_emission_enabled`, `ai_asset_replacement_enabled`

**Media quality / rendering**
`enable_lanczos_upscaler_for_photos_bitmap`, `enable_lanczos_upscaler_for_vod_bitmap`, `lanczos_min_upscale_scale_for_vod`, `enable_lanczos_video_inline_chat`, `enable_lanczos_video_chat_fullscreen`, `enable_lanczos_video_status_fullscreen`, `enable_rx_video_enhance_chat_fullscreen`, `enable_rx_video_enhance_status`, `rx_video_enhance_max_short_edge_px`, `rx_video_enhance_sharpen_strength_x1000`, `enable_hybrid_video_transcoding`, `enable_hybrid_video_transcoding_for_valid_mp4`, `enable_cached_media_manager`, `wa_media_image_upload_cache`, `media_elst_timing_refinement_enabled`, `kaleidoscope_thumbnail_validation`, `wa_win_pdf_rendering_enabled`, `enable_tooltip_for_media_hub`

**Calls / screen share**
`enable_waiting_room_ui`, `enable_waiting_room_admin_ui`, `enable_waiting_room_logging`, `lobby_timeout_min`, `hand_raise_receiver_enabled`, `disable_raise_hand_1on1`, `enable_uwp_screen_share_teaching_tip`, `enable_uwp_share_any_window`, `call_screen_share_dual_stream_app_update_dialog_enabled`, `calling_screen_share_milestone_version`, `calling_audio_share_version`, `enable_hybrid_call_links_creation`, `enable_hybrid_call_links_join`, `enable_call_links_push_notification`, `enable_new_call_link_representation`, `enable_lid_call_link`, `schedule_call_show_join_button_time_interval_mins`, `schedule_call_show_upcoming_banner_time_interval_mins`, `enable_uwp_swap_video_stream`, `enable_grid_layout_tile_unification`, `max_num_participants_for_ss`, `windows_ss_capture_driver_type`

**Privacy / security**
`privacy_screen_enabled`, `privacy_settings_about_lid_migration_enable`, `privacy_settings_group_add_lid_migration_enable`, `privacy_settings_profile_lid_migration_enable`, `privacy_settings_stickers_lid_migration_enable`, `defense_mode_available`, `defense_mode_quarantine`, `defense_mode_quarantine_bulk_unblock_limit`, `defense_mode_quarantine_message_expiration_window`, `cci_compliance_mm`, `cci_compliance_ctwa`, `mark_as_verified_enabled`

**Devices / multidevice**
`enable_windows_xdr_chat_handoff`, `enable_windows_xdr_wns_pkey`, `enable_uwp_device_switch_banner`, `device_switching_enabled`, `adv_accept_hosted_devices`, `max_number_of_frequently_used_contacts_shared_with_device`, `max_number_of_recent_contacts_shared_with_device`, `enable_3p_contacts_share_hybrid`, `enable_sharing_files_from_web_windows_hybrid`, `enable_hybrid_open_with_shared_buffer`, `hybrid_save_as_shared_buffer_enabled`, `hybrid_educational_dialogs_enabled`

**Groups / communities**
`group_history_receive`, `group_history_send`, `group_history_settings`, `group_history_settings_toggle_ui`, `group_history_receiver_floating_banner`, `group_history_notice_receive`, `group_history_message_count_limit`, `group_history_message_count_receiver_upper_limit`, `group_member_updates_usernames_enabled`, `group_member_updates_usernames_ui_enabled`, `group_member_updates_hide_in_thread_enabled`, `group_member_updates_past_participant_migration_enabled`, `member_name_tag_receiver_enabled`, `member_name_tag_sender_enabled`, `member_name_tag_db_enabled`, `group_create_add_using_lid_jids`, `pending_group_requests_persistent_banner`, `silent_group_username_activities_enabled`
plus `named_types.txt` → `[WhatsApp.Core] GroupSettingAnyoneCanAdd` (HIGH) — "everyone can add" group privacy setting.

**AI**
`ai_search_experience_enabled`, `ai_search_experience_web_enabled`, `ai_search_meta_ai_send_button_enabled`, `ai_search_null_state_enabled`, `ai_search_bar_2025_redesign_enabled`, `ai_chat_meta_ai_banner_m2_enabled`, `ai_groups_open_enabled`, `ai_rich_response_forward_receiving_enabled`, `ai_simplified_profile_page_enabled`, `ai_bot_integration_enabled`, `ai_hatch_integration_tab_enabled`, `ai_3p_agent_media_support_mode`, `ai_genai_straw_hat`

**Business / payments**
`payments_br_pix_on_web`, `payments_br_p2m_pix_copy_code_buyer_logging`, `payments_br_p2p_pix_copy_code_buyer_logging`, `payments_br_payment_links_buyer_logging`, `ctwa_fix_unknown_agm_insertion_issue_for_businesses`, `ctwa_tos_filtering_enabled`, `ctwa_ctx_disclosure_update_enabled`, `mm_data_sharing_disclosure_enabled`, `mm_data_sharing_disclosure_enabled_companion_history_sync`, `mm_data_sharing_disclosure_enabled_additional_transparency_large_screens`, `data_sharing_transparency_indicator_duration`, `disclosure_for_the_marketing_message_body_links_enabled`, `shimmed_links_in_the_marketing_message_body_enabled`
plus `named_types.txt` → `[WhatsApp.Core] SmbPerCustomerDataSharingControl` (views.txt) and `[WhatsApp.Core] SmbDataSharingConsentSetting` (HIGH) — SMB per-customer data sharing and consent.

**Platform**
`wa_web_adaptive_layout_enabled`, `webview2_disable_gpu_acceleration`, `webview2_enable_offline_support`, `win_hybrid_use_minimal_window`, `windows_graceful_degradation_version`, `enable_windows_jumplist_hybrid`, `enable_windows_hybrid_jumplist_contacts`

---

# Section E — Cross-reference index: clone status vs. real app

Evidence from `G:\Proyectos\16-whatsapp2\docs\TAURI_PARITY.md` (this repo) and the baseline above.

| Real-app capability | Evidence | Clone parity row | Clone state |
| --- | --- | --- | --- |
| Edit sent message | `MessageType.MessageEdit=1027`, `EditType`, `EditOutcome`, `cross_device_message_editing` | MS-17, CP-15 | Missing |
| Delete for me / everyone | `DeleteActionType`, `RevokeType`, `UIRevokeActionType`, `SnackbarDeleteUndo` | MS-18, CP-16 | Missing |
| Forward / multi-select | `MessageContextMenuOptionType.Forward/ForwardSelectMessages`, `ForwardPicker`, `ForwardSource` | CP-17 | Missing |
| Starred messages | `StarMessage`, `ViewStarredMessages`, `MessageContextMenuOptionType.StarOrUnstar` | MS-20 | Missing |
| Message context menu (40 options) | `MessageContextMenuOptionType` | MS-22 | Missing |
| Pin/unpin | `PinInChatType`, `MessageContextMenuOptionType.PinOrUnpin` | IN-07 | Core/UI present |
| Set disappearing timer | `DisappearingModeEntryPointType`, `EphemeralSetting` | IN-05 | Missing (display only) |
| Communities | `CommunityCreationActionTakenType`, `CommunityUIFeatureType` | IN-15 | Missing |
| Reply / quote | `QuotedMessageUserJourneyAction`, `ContextInfo.QuotedMessage` | MS-05, CP-02 | Present |
| Reactions | `ReactionActionType`, `PositronReaction` | MS-10, CP-07 | Present |
| Polls | `PollActionType`, `PollType` (POLL/QUIZ) | CP-14 | Present |
| Voice note recorder | `PttMessageUserJourneyAction` | CP-12 | Partial (recorder missing) |
| Contact + location message | `ContactMessage`, `LocationMessage`, `LiveLocationMessage` | CP-13 | Missing |
| Text formatting | `WhatsApp.RichTextFormat`, `RichTextFormatting.Processors.*` | CP-19 | Missing |
| Link preview | `UrlPreviewState`, `LinkPreviewProvider` | MS-09 | Local presentation only |
| Media viewer | `MediaViewerActionType` (30 actions) | MS-14 | Partial |
| Message info sheet | `MultideviceActionType.MessageInfo` | — | Missing |
| Scheduled messages | `ScheduledMessageActionType`, `WaScheduledTask` | — | Missing |
| Translate / transcribe / speak | `TranslationAction`, `TranscriptionRequestType`, `MessageContextMenuOptionType.Speak` | — | Missing |
| Ask Meta AI | `MessageContextMenuOptionType.AskMetaAI`, `MediaViewerActionType.TapAskMetaAI` | — | Missing |
| Media editing (rotate, crop, sticker maker, trim) | `MediaViewerActionType.Rotate/CreateSticker/Edit`, `MediaOperation.Trim`, `StickerMakerAction` | — | Missing |
| Media gallery / hub filters | `ChatFilterTypes` (Photos, Gifs, Links, Videos, Documents, Audios, Stickers) | — | Missing |
| Chat themes / wallpaper | `ChatThemeEntryType`, `ChatWallpaperType` | — | Missing |
| Chat lock (secret code) | `ChatLockActionType`, `ChatLockSettings` | — | Missing |
| Export chat | `ChatExport` | — | Missing |
| Label / folder | `LabelOperations`, `ChatsFolderType` | — | Missing |

---

# Section F — Method notes and limitations

1. **Source of truth.** `views.txt` (97) is the *native* XAML view list only. It is not a UI map of the chat screen, because the chat screen is WebView2.
2. **Feature evidence is telemetry-shaped.** WhatsApp names a WAM (telemetry) enum for nearly every user-visible action. `WhatsApp.Wam.Enum.*` (1796 enums) and `WhatsApp.Wam.Event.*` are therefore the closest thing to a feature catalogue in the binaries, and this baseline leans on them heavily.
3. **Enum values were read via reflection** from the shipped DLLs in the same folder (`WhatsApp.Core.dll`, `WhatsApp.Protobuf.dll`, `WhatsApp.DataModels.dll`), so all value lists in this document are exact, not inferred.
4. **Limitations.**
   - `WhatsApp.Root.dll` and `WhatsApp.Design.dll` could only be partially reflected (217/1204 and 170/925 types) because the Windows App SDK runtime is not installed in the analysis environment. Type *names* for those assemblies are still present in `named_types.txt` and are used as evidence, but member-level detail for them is missing.
   - `WhatsAppNative.dll`, `WhatsAppNative.Voip.dll` and `WhatsAppRust.dll` could not be reflected at all (native / Rust). Their projected types appear via `WhatsAppNativeProjection.dll` and are used where present.
   - The web app bundle (the actual chat UI) is not in the artifacts. Any feature that exists only in JavaScript and has no telemetry enum, no protocol type, and no native bridge is **invisible to this baseline**. Section B2 lists the known such gaps.
5. **No runtime verification was performed.** Every entry is a static-artifact claim.

---

# Appendix — quick index of the highest-signal artifacts

| Question | Go to |
| --- | --- |
| What message types exist? | `WhatsApp.MessageType` (DataModels) · `WhatsApp.ProtoBuf.MessageTypes` (Protobuf) · `RenderBubbleType` (Core) · `MediaType` (Core) |
| What can the message menu do? | `MessageContextMenuOptionType` (40 options) |
| What can the media viewer do? | `MediaViewerActionType` (30 actions) |
| What can the chat-header menu do? | `MoreMenuActionType` (33 entries) |
| What is in the composer? | `ChatComposerActionTargets` · `TextMessageUserJourneyAction` · `PttMessageUserJourneyAction` |
| What filters exist in the chat list / media hub? | `ChatFilterTypes` (28) |
| What is the call screen capable of? | `CallActionType` (146 actions) |
| What privacy controls exist? | `PrivacyControlItemType` (32) |
| What AI features exist? | `PrivateAIFeatureName` · `PrivateAIActionType` (120) · `MetaAIActionEntryPoint` |
| What channel/newsletter features exist? | `ChannelMenuItemType` · `ChannelEventType` · `ChatEntryPoint` (67) |
| What status features exist? | `StatusPrivacyType` · `StatusPrivacySettingsAction` (46) · `StatusRowSection` (41) |
| What native XAML exists? | `views.txt` (97) |
| What is behind a runtime flag? | `abprops_list.txt` (1210 `AbPropertyCode.*`) |
