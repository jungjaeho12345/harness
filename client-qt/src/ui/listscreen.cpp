#include "ui/listscreen.h"

#include "ui/theme.h"

#include <QAbstractItemView>
#include <QApplication>
#include <QColor>
#include <QEvent>
#include <QFont>
#include <QFontMetrics>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QJsonObject>
#include <QLabel>
#include <QLocale>
#include <QMouseEvent>
#include <QPainter>
#include <QPushButton>
#include <QRegularExpression>
#include <QStyle>
#include <QStyleOptionViewItem>
#include <QStyledItemDelegate>
#include <QTableWidget>
#include <QTableWidgetItem>
#include <QVBoxLayout>

#include <cmath>

namespace ui {
namespace {

// listFormat.js formatCell's four time columns.
bool isTimeKey(const QString &key)
{
    return key == QLatin1String("createdAt") || key == QLatin1String("editedAt") || key == QLatin1String("sentAt")
        || key == QLatin1String("distributedAt");
}

// JS String(value) for the scalar cells of a list row ('' for null / absent - formatCell).
QString jsString(const QJsonValue &value)
{
    switch (value.type()) {
    case QJsonValue::String:
        return value.toString();
    case QJsonValue::Bool:
        return value.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    case QJsonValue::Double: {
        const double number = value.toDouble();
        if (number == std::trunc(number) && std::fabs(number) < 1e21)
            return QString::number(static_cast<qint64>(number));
        return QString::number(number, 'g', QLocale::FloatingPointShortest);
    }
    case QJsonValue::Null:
    case QJsonValue::Undefined:
    case QJsonValue::Array:   // no list column holds one
    case QJsonValue::Object:
        return QString();
    }
    return QString();
}

// statusBadge.js STATUS_BADGES - the UI_GUIDE badge tokens (grey / red / amber / slate / indigo).
struct BadgeRow {
    const char *status;
    const char *background;
    const char *foreground;
};
const BadgeRow kBadges[] = {{"RDS", "#e8e8e8", "#555"}, {"DPS", "#c8102e", "#fff"}, {"RRH", "#d97706", "#fff"},
                            {"DDH", "#d97706", "#fff"}, {"EEH", "#d97706", "#fff"}, {"RRK", "#374151", "#fff"},
                            {"DDK", "#374151", "#fff"}, {"EEK", "#374151", "#fff"}, {"DPD", "#374151", "#fff"},
                            {"EPS", "#4f46e5", "#fff"}, {"DES", "#6366f1", "#fff"}};

// Paints a cell: the hovered row's tint under every cell, and the status cell as a badge
// (.yh-badge: padding 1px 6px, radius 3px, 0.7rem, bold). The item's own text stays the status code.
class ListCellDelegate : public QStyledItemDelegate
{
public:
    ListCellDelegate(int statusColumn, const int *hoveredRow, QObject *parent)
        : QStyledItemDelegate(parent), m_statusColumn(statusColumn), m_hoveredRow(hoveredRow)
    {
    }

    void paint(QPainter *painter, const QStyleOptionViewItem &option, const QModelIndex &index) const override
    {
        if (index.row() == *m_hoveredRow)
            painter->fillRect(option.rect, QColor(theme::kBlueLightRed, theme::kBlueLightGreen, theme::kBlueLightBlue,
                                                  theme::kBlueLightAlpha));
        if (index.column() != m_statusColumn) {
            QStyledItemDelegate::paint(painter, option, index);
            return;
        }
        // The cell itself (its bottom rule) without the text, then the badge over it.
        QStyleOptionViewItem cell(option);
        initStyleOption(&cell, index);
        const QString status = cell.text;
        cell.text.clear();
        QStyle *style = option.widget ? option.widget->style() : QApplication::style();
        style->drawControl(QStyle::CE_ItemViewItem, &cell, painter, option.widget);

        const StatusBadge badge = statusBadgeFor(status);
        if (badge.label.isEmpty())
            return;
        QFont font = option.font;
        font.setBold(true);
        font.setPixelSize(10);
        const QFontMetrics metrics(font);
        const int width = metrics.horizontalAdvance(badge.label) + 12;
        const int height = metrics.height() + 2;
        const QRect pill(option.rect.left() + theme::kSpaceSm, option.rect.center().y() - height / 2, width, height);
        painter->save();
        painter->setRenderHint(QPainter::Antialiasing);
        painter->setPen(Qt::NoPen);
        painter->setBrush(QColor(badge.background));
        painter->drawRoundedRect(pill, 3, 3);
        painter->setPen(QColor(badge.foreground));
        painter->setFont(font);
        painter->drawText(pill, Qt::AlignCenter, badge.label);
        painter->restore();
    }

private:
    int m_statusColumn;
    const int *m_hoveredRow;  // the screen's - it owns this painter
};

} // namespace

const QList<ListColumn> &listColumnCatalog()
{
    // columnConfig.js COLUMNS: same keys, labels and order. distributedAt is the one hidden by default
    // (override L97/L100) - turning it on is the column settings' job (P7).
    static const QList<ListColumn> catalog{
        {QStringLiteral("articleId"), QStringLiteral("기사아이디"), true},
        {QStringLiteral("title"), QStringLiteral("제목"), true},
        {QStringLiteral("author"), QStringLiteral("작성자"), true},
        {QStringLiteral("modifier"), QStringLiteral("수정자"), true},
        {QStringLiteral("department"), QStringLiteral("부서"), true},
        {QStringLiteral("departmentCode"), QStringLiteral("부서코드"), true},
        {QStringLiteral("createdAt"), QStringLiteral("작성시간"), true},
        {QStringLiteral("editedAt"), QStringLiteral("수정시간"), true},
        {QStringLiteral("sentAt"), QStringLiteral("송고시간"), true},
        {QStringLiteral("distributedAt"), QStringLiteral("배부시간"), false},
        {QStringLiteral("status"), QStringLiteral("기사상태"), true},
        {QStringLiteral("lockYN"), QStringLiteral("LockYN"), true}};
    return catalog;
}

QList<ListColumn> listColumns()
{
    QList<ListColumn> shown;
    for (const ListColumn &column : listColumnCatalog()) {
        if (column.defaultVisible)
            shown << column;
    }
    return shown;
}

QString formatListTime(const QString &iso)
{
    // listFormat.js applyDateFormat(iso, 'YYYY-MM-DD HH:mm'): the stored digits, no time-zone arithmetic.
    if (iso.isEmpty())
        return QString();
    static const QRegularExpression re(QStringLiteral(R"(^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}))"));
    const QRegularExpressionMatch m = re.match(iso);
    if (!m.hasMatch())
        return iso;
    return QStringLiteral("%1-%2-%3 %4:%5").arg(m.captured(1), m.captured(2), m.captured(3), m.captured(4), m.captured(5));
}

QString formatListCell(const QString &key, const QJsonValue &value)
{
    if (isTimeKey(key))
        return formatListTime(value.isString() ? value.toString() : QString());
    return jsString(value);
}

StatusBadge statusBadgeFor(const QString &status)
{
    for (const BadgeRow &row : kBadges) {
        if (status == QLatin1String(row.status))
            return StatusBadge{status, QLatin1String(row.background), QLatin1String(row.foreground)};
    }
    return StatusBadge{status, QStringLiteral("#e8e8e8"), QStringLiteral("#555")};  // statusBadge.js FALLBACK
}

ListScreen::ListScreen(QWidget *parent) : QWidget(parent)
{
    const QList<ListColumn> columns = listColumns();
    int statusColumn = -1;
    int titleColumn = -1;
    QStringList labels;
    for (int i = 0; i < columns.size(); ++i) {
        labels << columns.at(i).label;
        if (columns.at(i).key == QLatin1String("status"))
            statusColumn = i;
        if (columns.at(i).key == QLatin1String("title"))
            titleColumn = i;
    }

    auto *layout = new QVBoxLayout(this);
    layout->setContentsMargins(theme::kSpaceLg, theme::kSpaceLg, theme::kSpaceLg, theme::kSpaceLg);
    layout->setSpacing(theme::kSpaceSm);

    // The one P4 menu's name (ListPage.jsx MENU_LABELS.deskUnsent). There is no menu bar - P7's.
    m_title = new QLabel(QStringLiteral("데스크 미송고"), this);
    m_title->setObjectName(QStringLiteral("listTitle"));
    m_title->setStyleSheet(QStringLiteral("color: %1; font-size: 15px; font-weight: 700;").arg(QLatin1String(theme::kInk)));

    m_error = new QLabel(this);
    m_error->setObjectName(QStringLiteral("listError"));
    m_error->setWordWrap(true);
    m_error->setStyleSheet(QStringLiteral("color: %1;").arg(QLatin1String(theme::kRed)));
    m_error->setHidden(true);

    // .yh-table: 0.88rem, thead #f5f5f5 with a 2 px blue rule, 1 px #ddd under every cell, no grid.
    m_table = new QTableWidget(0, static_cast<int>(columns.size()), this);
    m_table->setObjectName(QStringLiteral("listTable"));
    m_table->setHorizontalHeaderLabels(labels);
    m_table->verticalHeader()->setVisible(false);
    m_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
    m_table->setSelectionMode(QAbstractItemView::NoSelection);
    m_table->setContextMenuPolicy(Qt::NoContextMenu);
    m_table->setFocusPolicy(Qt::NoFocus);
    m_table->setShowGrid(false);
    m_table->setWordWrap(false);
    m_table->setMouseTracking(true);
    m_table->viewport()->installEventFilter(this);
    m_table->setItemDelegate(new ListCellDelegate(statusColumn, &m_hoveredRow, m_table));
    QHeaderView *header = m_table->horizontalHeader();
    header->setSectionsClickable(false);  // no click-to-sort: the order is the controller's
    header->setHighlightSections(false);
    header->setDefaultAlignment(Qt::AlignLeft | Qt::AlignVCenter);
    header->setSectionResizeMode(QHeaderView::ResizeToContents);
    if (titleColumn >= 0)
        header->setSectionResizeMode(titleColumn, QHeaderView::Stretch);
    m_table->setStyleSheet(QStringLiteral("QTableWidget#listTable { border: none; background: #ffffff; color: %1; font-size: 12px; }"
                                          "QTableWidget#listTable::item { border-bottom: 1px solid %2; padding: 4px 8px; }"
                                          "QHeaderView::section { background: %3; color: %1; font-weight: 700; border: none;"
                                          " border-bottom: 2px solid %4; padding: 5px 8px; }")
                               .arg(QLatin1String(theme::kInk), QLatin1String(theme::kLine), QLatin1String(theme::kGrayBg),
                                    QLatin1String(theme::kBlue)));

    auto *pager = new QHBoxLayout();
    pager->setSpacing(theme::kSpaceSm);
    m_previous = new QPushButton(QStringLiteral("이전"), this);
    m_previous->setObjectName(QStringLiteral("previousPageButton"));
    m_next = new QPushButton(QStringLiteral("다음"), this);
    m_next->setObjectName(QStringLiteral("nextPageButton"));
    m_page = new QLabel(this);
    m_page->setObjectName(QStringLiteral("pageLabel"));
    m_page->setStyleSheet(QStringLiteral("color: %1;").arg(QLatin1String(theme::kInk)));
    pager->addStretch(1);
    pager->addWidget(m_previous);
    pager->addWidget(m_page);
    pager->addWidget(m_next);
    pager->addStretch(1);
    connect(m_previous, &QPushButton::clicked, this, &ListScreen::previousPageRequested);
    connect(m_next, &QPushButton::clicked, this, &ListScreen::nextPageRequested);

    layout->addWidget(m_title);
    layout->addWidget(m_error);
    layout->addWidget(m_table, 1);
    layout->addLayout(pager);

    render(ListViewState());
}

void ListScreen::render(const ListViewState &state)
{
    const QList<ListColumn> columns = listColumns();
    m_table->setRowCount(0);  // replace, never append
    m_table->setRowCount(static_cast<int>(state.rows.size()));
    for (int r = 0; r < state.rows.size(); ++r) {
        const QJsonObject &row = state.rows.at(r);
        for (int c = 0; c < columns.size(); ++c) {
            const QString &key = columns.at(c).key;
            auto *item = new QTableWidgetItem(formatListCell(key, row.value(key)));
            // override L104: the time columns are centred (.yh-col--time); everything else left.
            item->setTextAlignment(isTimeKey(key) ? Qt::Alignment(Qt::AlignCenter) : (Qt::AlignLeft | Qt::AlignVCenter));
            m_table->setItem(r, c, item);
        }
    }
    setHoveredRow(-1);

    m_page->setText(QStringLiteral("%1 / %2 · 총 %3건").arg(state.page).arg(state.pageCount).arg(state.total));
    m_previous->setEnabled(state.page > 1);
    m_next->setEnabled(state.page < state.pageCount);
    m_error->setText(state.error);
    m_error->setHidden(state.error.isEmpty());
}

int ListScreen::rowCount() const
{
    return m_table->rowCount();
}

QString ListScreen::cellText(int row, int column) const
{
    const QTableWidgetItem *item = m_table->item(row, column);
    return item ? item->text() : QString();
}

QString ListScreen::pageText() const
{
    return m_page->text();
}

QString ListScreen::errorText() const
{
    return m_error->text();
}

bool ListScreen::eventFilter(QObject *watched, QEvent *event)
{
    if (watched == m_table->viewport()) {
        if (event->type() == QEvent::MouseMove)
            setHoveredRow(m_table->rowAt(static_cast<QMouseEvent *>(event)->position().toPoint().y()));
        else if (event->type() == QEvent::Leave)
            setHoveredRow(-1);
    }
    return QWidget::eventFilter(watched, event);
}

void ListScreen::setHoveredRow(int row)
{
    if (row == m_hoveredRow)
        return;
    m_hoveredRow = row;
    m_table->viewport()->update();
}

} // namespace ui
