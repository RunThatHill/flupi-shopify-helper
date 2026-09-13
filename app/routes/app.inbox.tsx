import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useState, useEffect, useRef } from "react";
import { getConversations, getConversationMessages, markConversationAsRead } from "../chat.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const search = url.searchParams.get("search") || undefined;
  const conversations = await getConversations(search);
  const instapayOrders = await db.instapayOrderQueue.findMany({
    orderBy: { createdAt: "desc" }
  });

  return json({ conversations, instapayOrders });
};

export default function WhatsAppInbox() {
  const { conversations: initialConversations, instapayOrders } = useLoaderData<typeof loader>();
  const [conversations, setConversations] = useState(initialConversations);
  const [activeConvId, setActiveConvId] = useState<string | null>(initialConversations[0]?.id || null);
  const [messages, setMessages] = useState<any[]>([]);
  const [replyText, setReplyText] = useState("");
  const [agentName, setAgentName] = useState("");
  const [search, setSearch] = useState("");
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const previousUnreadSum = useRef<number>(0);

  // Load saved agent name from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("flupi_agent_name");
    if (saved) setAgentName(saved);
  }, []);

  // Save agent name changes
  const handleAgentNameChange = (val: string) => {
    setAgentName(val);
    localStorage.setItem("flupi_agent_name", val);
  };

  // Web Audio Notification synthesizer
  const playNotificationSound = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5 note
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15); // A5 note
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) {
      console.warn("Audio Context error:", e);
    }
  };

  // Poll for conversation updates every 3 seconds
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/chat${search ? `?search=${encodeURIComponent(search)}` : ""}`);
        if (res.ok) {
          const data = await res.json();
          if (data.conversations) {
            setConversations(data.conversations);

            // Check for new unread messages
            const currentUnreadSum = data.conversations.reduce((sum: number, c: any) => sum + (c.unreadCount || 0), 0);
            if (currentUnreadSum > previousUnreadSum.current && audioEnabled) {
              playNotificationSound();
              if (Notification.permission === "granted") {
                new Notification("New WhatsApp Message - Flùpi CRM", {
                  body: "You have a new customer message waiting in your inbox."
                });
              }
            }
            previousUnreadSum.current = currentUnreadSum;
          }
        }
      } catch (err) {
        console.error("Polling error:", err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [search, audioEnabled]);

  // Load messages when active conversation changes
  useEffect(() => {
    if (!activeConvId) return;

    setLoadingMessages(true);
    fetch(`/api/chat?conversationId=${activeConvId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.messages) {
          setMessages(data.messages);
        }
      })
      .finally(() => setLoadingMessages(false));
  }, [activeConvId]);

  // Scroll to bottom when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Active conversation object & matched Shopify Order
  const activeConv = conversations.find((c: any) => c.id === activeConvId);
  const matchedOrder = activeConv
    ? instapayOrders.find((o: any) => 
        o.customerPhone.endsWith(activeConv.customerPhone.slice(-10)) ||
        o.shopifyOrderId === activeConv.shopifyOrderId
      )
    : null;

  // Handle sending agent reply
  const handleSendReply = async () => {
    if (!replyText.trim() || !activeConv || sending) return;

    setSending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerPhone: activeConv.customerPhone,
          message: replyText.trim(),
          agentName: agentName || "Flùpi Support",
          shopifyOrderId: matchedOrder?.shopifyOrderId,
          conversationId: activeConv.id
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.message) {
          setMessages((prev) => [...prev, data.message]);
          setReplyText("");
        }
      }
    } catch (err) {
      console.error("Send reply error:", err);
    } finally {
      setSending(false);
    }
  };

  // Handle Mark as Paid
  const handleMarkAsPaid = async () => {
    if (!matchedOrder) return;
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          shopifyOrderId: matchedOrder.shopifyOrderId
        })
      });
      if (res.ok) {
        alert(`Order ${matchedOrder.orderNumber} successfully marked as PAID!`);
        window.location.reload();
      }
    } catch (err) {
      alert("Failed to mark order as paid");
    }
  };

  // Request browser notification permission
  const enableNotifications = () => {
    if ("Notification" in window) {
      Notification.requestPermission();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-100 font-sans">
      {/* Top Header */}
      <header className="flex items-center justify-between px-6 py-3 bg-slate-800 border-b border-slate-700">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center font-bold text-white text-sm">
            💬
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide">Flùpi WhatsApp Live CRM Inbox</h1>
            <p className="text-xs text-slate-400">Manage real-time customer chats, order proofs & notifications</p>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2 bg-slate-700 px-3 py-1.5 rounded-lg border border-slate-600">
            <span className="text-xs text-slate-300">Agent Name:</span>
            <input
              type="text"
              placeholder="e.g. Sarah"
              value={agentName}
              onChange={(e) => handleAgentNameChange(e.target.value)}
              className="bg-slate-900 text-xs px-2 py-1 rounded text-purple-300 font-medium focus:outline-none border border-slate-700"
            />
          </div>

          <button
            onClick={() => {
              setAudioEnabled(!audioEnabled);
              enableNotifications();
            }}
            className={`text-xs px-3 py-1.5 rounded-lg border font-medium flex items-center space-x-1 transition ${
              audioEnabled
                ? "bg-purple-950/80 text-purple-300 border-purple-600"
                : "bg-slate-800 text-slate-400 border-slate-700"
            }`}
          >
            <span>{audioEnabled ? "🔔 Audio Alerts ON" : "🔕 Audio Alerts OFF"}</span>
          </button>
        </div>
      </header>

      {/* Main 3-Column Content Container */}
      <div className="flex flex-1 overflow-hidden">
        {/* Column 1: Conversations List */}
        <div className="w-80 bg-slate-800/90 border-r border-slate-700 flex flex-col">
          <div className="p-3 border-b border-slate-700">
            <input
              type="text"
              placeholder="Search phone or name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-slate-900 text-xs px-3 py-2 rounded-lg border border-slate-700 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-purple-500"
            />
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-700/50">
            {conversations.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400">No active conversations found</div>
            ) : (
              conversations.map((conv: any) => {
                const isActive = conv.id === activeConvId;
                const dateStr = new Date(conv.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                return (
                  <button
                    key={conv.id}
                    onClick={() => setActiveConvId(conv.id)}
                    className={`w-full text-left p-3.5 transition flex items-start space-x-3 ${
                      isActive ? "bg-slate-700/80 border-l-4 border-purple-500" : "hover:bg-slate-700/40"
                    }`}
                  >
                    <div className="w-10 h-10 rounded-full bg-slate-600 flex-shrink-0 flex items-center justify-center font-bold text-slate-200 text-sm">
                      {conv.customerName ? conv.customerName.charAt(0).toUpperCase() : "👤"}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-baseline mb-1">
                        <h2 className="text-xs font-semibold text-slate-200 truncate">
                          {conv.customerName || conv.customerPhone}
                        </h2>
                        <span className="text-[10px] text-slate-400">{dateStr}</span>
                      </div>
                      <p className="text-xs text-slate-400 truncate">{conv.lastMessage || "No messages yet"}</p>
                    </div>

                    {conv.unreadCount > 0 && (
                      <span className="bg-purple-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                        {conv.unreadCount}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Column 2: Active Chat Messages Thread */}
        <div className="flex-1 flex flex-col bg-slate-900">
          {activeConv ? (
            <>
              {/* Chat Thread Header */}
              <div className="px-6 py-3 bg-slate-800/60 border-b border-slate-700 flex justify-between items-center">
                <div>
                  <h2 className="text-sm font-bold text-slate-200">{activeConv.customerName || activeConv.customerPhone}</h2>
                  <p className="text-xs text-purple-400 font-mono">+{activeConv.customerPhone}</p>
                </div>
                {matchedOrder && (
                  <span className="text-xs bg-purple-900/60 text-purple-300 px-2.5 py-1 rounded-full border border-purple-700">
                    Linked Order {matchedOrder.orderNumber}
                  </span>
                )}
              </div>

              {/* Messages Area */}
              <div className="flex-1 p-6 overflow-y-auto space-y-4">
                {loadingMessages ? (
                  <div className="text-center text-xs text-slate-500 py-10">Loading message thread...</div>
                ) : messages.length === 0 ? (
                  <div className="text-center text-xs text-slate-500 py-10">No messages in this chat history</div>
                ) : (
                  messages.map((msg: any) => {
                    const isInbound = msg.direction === "inbound";
                    const timeStr = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                    return (
                      <div
                        key={msg.id}
                        className={`flex flex-col ${isInbound ? "items-start" : "items-end"}`}
                      >
                        <div className="text-[10px] text-slate-400 mb-1 px-1">
                          {msg.senderName || (isInbound ? "Customer" : "Agent")} • {timeStr}
                        </div>

                        <div
                          className={`max-w-md rounded-2xl px-4 py-2.5 text-xs shadow-md ${
                            isInbound
                              ? "bg-slate-800 text-slate-200 rounded-tl-none border border-slate-700"
                              : "bg-purple-600 text-white rounded-tr-none"
                          }`}
                        >
                          {msg.mediaUrl && (
                            <div className="mb-2">
                              <a href={msg.mediaUrl} target="_blank" rel="noreferrer">
                                <img
                                  src={msg.mediaUrl}
                                  alt="Payment Proof Screenshot"
                                  className="max-w-xs max-h-60 rounded-lg border border-slate-600 object-cover cursor-pointer hover:opacity-90"
                                />
                              </a>
                              <span className="text-[10px] text-purple-200 mt-1 block">Click photo to view full size</span>
                            </div>
                          )}

                          {msg.body && <p className="whitespace-pre-wrap leading-relaxed">{msg.body}</p>}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Reply Input Bar */}
              <div className="p-4 bg-slate-800 border-t border-slate-700">
                <div className="flex items-center space-x-2 mb-2">
                  <span className="text-[10px] text-slate-400">Quick Templates:</span>
                  <button
                    onClick={() => setReplyText("Thank you for your payment proof! We are verifying it now.")}
                    className="text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-300 px-2 py-0.5 rounded border border-slate-600"
                  >
                    Proof Received
                  </button>
                  <button
                    onClick={() => setReplyText("Your payment has been verified and your order is confirmed! 🎉")}
                    className="text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-300 px-2 py-0.5 rounded border border-slate-600"
                  >
                    Payment Confirmed
                  </button>
                </div>

                <div className="flex items-center space-x-3">
                  <textarea
                    rows={2}
                    placeholder={`Reply as ${agentName || "Flùpi Support"}...`}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendReply();
                      }
                    }}
                    className="flex-1 bg-slate-900 text-xs p-3 rounded-xl border border-slate-700 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-purple-500 resize-none"
                  />
                  <button
                    onClick={handleSendReply}
                    disabled={sending || !replyText.trim()}
                    className="h-12 px-5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition shadow-lg flex items-center justify-center space-x-1"
                  >
                    <span>{sending ? "Sending..." : "Send Reply"}</span>
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-500">
              Select a conversation from the left panel to start chatting
            </div>
          )}
        </div>

        {/* Column 3: Shopify Order & Customer Card */}
        <div className="w-80 bg-slate-800/80 border-l border-slate-700 p-5 overflow-y-auto">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">Customer & Order Details</h3>

          {matchedOrder ? (
            <div className="space-y-4 text-xs">
              <div className="bg-slate-900 p-4 rounded-xl border border-slate-700 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="font-bold text-purple-300 text-sm">{matchedOrder.orderNumber}</span>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      matchedOrder.status === "CONFIRMED"
                        ? "bg-emerald-950 text-emerald-400 border border-emerald-700"
                        : matchedOrder.status === "PENDING_APPROVAL"
                        ? "bg-amber-950 text-amber-300 border border-amber-700"
                        : "bg-slate-800 text-slate-400 border border-slate-700"
                    }`}
                  >
                    {matchedOrder.status}
                  </span>
                </div>

                <div className="text-slate-300">
                  <p className="font-semibold">{matchedOrder.customerName}</p>
                  <p className="text-slate-400 text-[11px]">+{matchedOrder.customerPhone}</p>
                </div>

                <div className="pt-2 border-t border-slate-800 flex justify-between font-mono">
                  <span className="text-slate-400">Total Price:</span>
                  <span className="font-bold text-white">{matchedOrder.totalPrice} {matchedOrder.currency}</span>
                </div>
              </div>

              {/* Payment Proof Screenshot Preview */}
              {matchedOrder.screenshotPath && (
                <div className="bg-slate-900 p-3 rounded-xl border border-slate-700">
                  <span className="text-[11px] font-semibold text-slate-300 block mb-2">Instapay Payment Proof:</span>
                  <a href={matchedOrder.screenshotPath} target="_blank" rel="noreferrer">
                    <img
                      src={matchedOrder.screenshotPath}
                      alt="Instapay Proof Screenshot"
                      className="w-full max-h-56 object-cover rounded-lg border border-slate-700 hover:opacity-90 transition cursor-pointer"
                    />
                  </a>
                </div>
              )}

              {/* Quick Action Button */}
              {matchedOrder.status !== "CONFIRMED" && (
                <button
                  onClick={handleMarkAsPaid}
                  className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs shadow-lg transition"
                >
                  ✅ Approve & Mark as Paid in Shopify
                </button>
              )}
            </div>
          ) : (
            <div className="bg-slate-900 p-4 rounded-xl border border-slate-700 text-center text-xs text-slate-400">
              No matching Shopify Instapay order linked to this phone number
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
